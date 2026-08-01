const fs = require('fs');
const core = require('@actions/core');
const { HttpClient } = require('@actions/http-client');
const jira = require('./jira');
const slack = require('./slack');
const github = require('./github');

// Reads the GitHub event payload (pull request title, author, number, etc.).
function readEvent() {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath || !fs.existsSync(eventPath)) {
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    } catch (error) {
        return {};
    }
}

// Top-level attributes whose sole change is treated as cosmetic noise (bundled as
// a count instead of being sent for individual AI analysis).
const COSMETIC_ATTRS = new Set(['tags', 'tags_all']);

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// Top-level attribute names that differ between before/after. Values known only
// after apply count as changes. Names only — no values leave the runner (DLP).
function changedAttributes(change) {
    const before = change.before && typeof change.before === 'object' ? change.before : {};
    const after = change.after && typeof change.after === 'object' ? change.after : {};
    const afterUnknown = change.after_unknown && typeof change.after_unknown === 'object' ? change.after_unknown : {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(afterUnknown)]);
    const changed = [];
    for (const key of keys) {
        if (afterUnknown[key] || !deepEqual(before[key], after[key])) {
            changed.push(key);
        }
    }
    return changed.sort();
}

// Tag keys that differ inside the tags/tags_all maps (names only, never values).
function changedTagKeys(change) {
    const keys = new Set();
    for (const attr of ['tags', 'tags_all']) {
        const before = (change.before && change.before[attr]) || {};
        const after = (change.after && change.after[attr]) || {};
        const afterUnknown = (change.after_unknown && change.after_unknown[attr]) || {};
        const all = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(afterUnknown)]);
        for (const key of all) {
            if (afterUnknown[key] || !deepEqual(before[key], after[key])) {
                keys.add(key);
            }
        }
    }
    return [...keys];
}

// Canonical resource-block address, ignoring any count/for_each index, so all
// iterations of one block collapse together (module.x.type.name or type.name).
function blockAddress(resource) {
    if (resource.type && resource.name) {
        const prefix = resource.module_address ? `${resource.module_address}.` : '';
        return `${prefix}${resource.type}.${resource.name}`;
    }
    return resource.address;
}

// Grouping key: Terraform's canonical "module_address" when the resource is inside a
// module (groups all its resources together), or the resource block address for a
// standalone root resource (its count/for_each iterations still share one group).
// Universal — module_address is core Terraform, independent of provider/architecture.
function groupKey(resource) {
    return resource.module_address || blockAddress(resource);
}

// Categorizes a change for the per-module action breakdown and ranking.
function categorizeAction(actions) {
    const hasDelete = actions.includes('delete');
    const hasCreate = actions.includes('create');
    if (hasDelete && hasCreate) return 'replace';
    if (hasDelete) return 'delete';
    if (hasCreate) return 'create';
    return 'update';
}

// Ranks a resource-block breakdown so destructive blocks surface first within a group.
function breakdownRank(breakdown) {
    if (breakdown.replace + breakdown.delete > 0) return 0;
    if (breakdown.create > 0) return 1;
    return 2;
}

// Builds the reduced, sanitized payload sent to the backend (DLP applied here):
// only non-sensitive metadata leaves the runner. no-op/read are dropped, tag-only
// changes are bundled as a count, significant changes are grouped by module, and
// count/for_each iterations of a block are collapsed into one entry with an instance
// count + per-action breakdown (so mixed actions are never lost). The backend caps
// how many modules are analyzed and owns the payload ceiling.
function buildReducedPayload(plan, relevantTags) {
    const resourceChanges = Array.isArray(plan.resource_changes) ? plan.resource_changes : [];

    let cosmeticCount = 0;
    const significant = [];

    for (const resource of resourceChanges) {
        const change = resource.change || {};
        const actions = change.actions;
        if (!Array.isArray(actions)) {
            continue;
        }
        const onlyAction = actions.length === 1 ? actions[0] : null;
        if (onlyAction === 'no-op' || onlyAction === 'read') {
            continue;
        }

        if (onlyAction === 'update') {
            const changed = changedAttributes(change);
            const tagOnly = changed.length > 0 && changed.every((attr) => COSMETIC_ATTRS.has(attr));
            if (tagOnly) {
                // Cosmetic unless the change touches a tag the user flagged as relevant.
                const relevantChanged = relevantTags.length
                    ? changedTagKeys(change).filter((key) => relevantTags.includes(key))
                    : [];
                if (relevantChanged.length === 0) {
                    cosmeticCount += 1;
                    continue;
                }
                significant.push({ resource, actions, changed: relevantChanged.map((key) => `tags.${key}`) });
                continue;
            }
            significant.push({ resource, actions, changed });
        } else {
            significant.push({ resource, actions, changed: null });
        }
    }

    // Group by module (or singleton root), and within each group collapse a block's
    // count/for_each iterations into one entry. Every action_breakdown counts
    // instances, so a lone delete among many updates is always reported.
    const groups = new Map();
    for (const { resource, actions, changed } of significant) {
        const key = groupKey(resource);
        if (!groups.has(key)) {
            groups.set(key, {
                module: key,
                is_module: Boolean(resource.module_address),
                action_breakdown: { replace: 0, delete: 0, create: 0, update: 0 },
                entries: new Map(),
            });
        }
        const group = groups.get(key);
        const category = categorizeAction(actions);
        group.action_breakdown[category] += 1;

        const block = blockAddress(resource);
        if (!group.entries.has(block)) {
            group.entries.set(block, {
                address: block,
                first_address: resource.address,
                type: resource.type,
                name: resource.name,
                instances: 0,
                action_breakdown: { replace: 0, delete: 0, create: 0, update: 0 },
                changed: new Set(),
                action_reason: new Set(),
                replace_triggered_by: new Set(),
                destroyed: new Set(),
                recreated: new Set(),
            });
        }
        const entry = group.entries.get(block);
        entry.instances += 1;
        entry.action_breakdown[category] += 1;
        // Preserve which count/for_each instances suffer a destructive action so the
        // message and the LLM can name them (e.g. "destroyed: legacy"), not just count.
        if (resource.index !== undefined) {
            if (category === 'delete') entry.destroyed.add(String(resource.index));
            if (category === 'replace') entry.recreated.add(String(resource.index));
        }
        (changed || []).forEach((c) => entry.changed.add(c));
        if (resource.action_reason) {
            entry.action_reason.add(resource.action_reason);
        }
        const replacePaths = resource.change && resource.change.replace_paths;
        if (Array.isArray(replacePaths)) {
            replacePaths
                .map((path) => (Array.isArray(path) ? path[0] : path))
                .filter((step) => typeof step === 'string')
                .forEach((step) => entry.replace_triggered_by.add(step));
        }
    }

    // Finalize entries (Sets → arrays) and sort blocks destructive-first per group.
    // A single changed instance keeps its full indexed address; a collapsed block
    // additionally lists the specific instances hit by a destructive action.
    const finalizeEntry = (e) => {
        const out = {
            address: e.instances === 1 ? e.first_address : e.address,
            type: e.type,
            name: e.name,
            instances: e.instances,
            action_breakdown: e.action_breakdown,
        };
        if (e.changed.size) out.changed = [...e.changed].sort();
        if (e.action_reason.size) out.action_reason = [...e.action_reason];
        if (e.replace_triggered_by.size) out.replace_triggered_by = [...e.replace_triggered_by];
        if (e.instances > 1 && e.destroyed.size) out.destroyed_instances = [...e.destroyed];
        if (e.instances > 1 && e.recreated.size) out.recreated_instances = [...e.recreated];
        return out;
    };

    const modules = [...groups.values()].map((g) => ({
        module: g.module,
        is_module: g.is_module,
        action_breakdown: g.action_breakdown,
        resources: [...g.entries.values()]
            .map(finalizeEntry)
            .sort((x, y) => breakdownRank(x.action_breakdown) - breakdownRank(y.action_breakdown)),
    }));

    // Rank modules by risk: most destructive first (replace+delete instances, then
    // create, then update), so the backend's module cap keeps the highest-impact ones.
    modules.sort((a, b) => {
        const da = a.action_breakdown.replace + a.action_breakdown.delete;
        const db = b.action_breakdown.replace + b.action_breakdown.delete;
        if (da !== db) return db - da;
        if (a.action_breakdown.create !== b.action_breakdown.create) {
            return b.action_breakdown.create - a.action_breakdown.create;
        }
        return b.action_breakdown.update - a.action_breakdown.update;
    });

    return {
        payload: {
            format_version: plan.format_version,
            terraform_version: plan.terraform_version,
            modules,
            // The backend caps how many modules are analyzed and computes the final
            // analyzed/omitted counts; it only needs the true totals from the client.
            // significant_total counts resource instances (not collapsed blocks).
            change_summary: {
                total_changes: significant.length + cosmeticCount,
                cosmetic_omitted: cosmeticCount,
                significant_total: significant.length,
                modules_total: modules.length,
            },
        },
        significantCount: significant.length,
        cosmeticCount,
        moduleCount: modules.length,
        totalCount: resourceChanges.length,
    };
}

// Analysis phase: read the plan, reduce/sanitize it, authenticate via OIDC and
// send it to the backend. Returns the parsed backend response.
async function analyzePlan(httpClient) {
    const planPath = core.getInput('plan_path', { required: true });
    const apiUrl = core.getInput('api_url', { required: false });
    const audience = core.getInput('audience', { required: false });
    const relevantTagsRaw = core.getInput('relevant_tags', { required: false });
    const relevantTags = relevantTagsRaw
        ? relevantTagsRaw.split(',').map((tag) => tag.trim()).filter(Boolean)
        : [];

    core.info(`Reading Terraform plan from: ${planPath}`);
    if (!fs.existsSync(planPath)) {
        throw new Error(`Plan file not found at "${planPath}".`);
    }

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const { payload, significantCount, cosmeticCount, moduleCount, totalCount } = buildReducedPayload(plan, relevantTags);

    core.info(`Changes: ${significantCount} significant in ${moduleCount} module(s), ${cosmeticCount} cosmetic (tags), of ${totalCount} total.`);
    core.info(`Reduced plan sent to backend:\n${JSON.stringify(payload, null, 2)}`);
    core.setOutput('reduced_plan', JSON.stringify(payload));

    if (significantCount === 0) {
        core.info('No business-impacting changes to analyze (only cosmetic/no-op). Skipping backend call.');
        return null;
    }

    const idToken = await core.getIDToken(audience);
    const response = await httpClient.postJson(apiUrl, payload, {
        Authorization: `Bearer ${idToken}`,
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Backend responded with status ${response.statusCode}: ${JSON.stringify(response.result)}`);
    }

    core.info(`Plan summary sent successfully (status ${response.statusCode}).`);
    core.setOutput('response', JSON.stringify(response.result));
    const changeSummary = (response.result.metadata && response.result.metadata.change_summary) || null;
    return { result: response.result, changeSummary, payloadModules: payload.modules };
}

// Resolves the Jira issue keys from explicit input, PR title, or branch name.
// jira_project_keys (e.g. "PROJ,CORE") scopes the parser to real project prefixes.
function resolveIssueKeys(event) {
    const explicit = core.getInput('jira_issue_key', { required: false });
    if (explicit) {
        return [explicit];
    }
    const projectKeysRaw = core.getInput('jira_project_keys', { required: false });
    const projectKeys = projectKeysRaw
        ? projectKeysRaw.split(',').map((key) => key.trim().toUpperCase()).filter(Boolean)
        : [];

    const prTitle = (event.pull_request && event.pull_request.title) || '';
    const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || '';
    return [...new Set([
        ...jira.extractIssueKeys(prTitle, projectKeys),
        ...jira.extractIssueKeys(branch, projectKeys),
    ])];
}

// Runs a single channel delivery, isolating failures unless fail_on_error is set.
async function deliver(name, enabled, fn, failOnError) {
    if (!enabled) {
        return;
    }
    try {
        await fn();
    } catch (error) {
        if (failOnError) {
            throw new Error(`${name} delivery failed: ${error.message}`);
        }
        core.warning(`${name} delivery failed: ${error.message}`);
    }
}

// Renders a compact action breakdown string for a module header (skips zeros).
function breakdownLabel(breakdown) {
    const b = breakdown || {};
    const parts = [];
    if (b.replace) parts.push(`${b.replace} recreated`);
    if (b.delete) parts.push(`${b.delete} destroyed`);
    if (b.create) parts.push(`${b.create} created`);
    if (b.update) parts.push(`${b.update} updated`);
    return parts.join(', ');
}

// Verb for a block with a single action category (single, non-iterated resource).
const ACTION_WORD = { replace: 'recreated', delete: 'destroyed', create: 'created', update: 'updated' };

// Human label for one resource block, collapsing count/for_each iterations. A block
// with multiple instances shows the count + full breakdown so mixed actions (e.g. one
// delete among many updates) are always visible, and names the specific instances hit
// by a destructive action.
function resourceLabel(entry) {
    const bd = entry.action_breakdown || {};
    const instances = entry.instances || 1;
    if (instances > 1) {
        let label = `${entry.address} \u00d7${instances} \u2014 ${breakdownLabel(bd)}`;
        const notable = [];
        if (entry.recreated_instances && entry.recreated_instances.length) {
            notable.push(`recreated: ${entry.recreated_instances.join(', ')}`);
        }
        if (entry.destroyed_instances && entry.destroyed_instances.length) {
            notable.push(`destroyed: ${entry.destroyed_instances.join(', ')}`);
        }
        return notable.length ? `${label} (${notable.join('; ')})` : label;
    }
    const action = ['replace', 'delete', 'create', 'update'].find((k) => bd[k] > 0);
    return `${entry.address} (${ACTION_WORD[action] || 'updated'})`;
}

// Merges the LLM's per-module narrative with the deterministic resource list and
// action breakdown the client already computed, so sub-resources/counts are exact
// (the LLM only writes the business impact + risk per module).
function enrichModules(analysis, payloadModules) {
    const byName = new Map((payloadModules || []).map((m) => [m.module, m]));
    const llmModules = Array.isArray(analysis.modules) ? analysis.modules : [];
    return llmModules.map((m) => {
        const data = byName.get(m.module) || { resources: [], action_breakdown: {} };
        return {
            module: m.module,
            is_module: Boolean(data.is_module),
            business_impact: m.business_impact,
            risk: m.risk,
            action_summary: breakdownLabel(data.action_breakdown),
            resources: (data.resources || []).map((r) => ({ label: resourceLabel(r) })),
        };
    });
}

// Builds a deterministic notice about changes the client could not send for
// detailed analysis (module capacity cap / cosmetic noise). Null when nothing was
// omitted. Reports omitted resource counts (not just modules) so the reader knows
// the real magnitude behind an omitted group.
function buildCapacityNotice(changeSummary) {
    if (!changeSummary) {
        return null;
    }
    const parts = [];
    if (changeSummary.modules_omitted > 0) {
        const resources = changeSummary.resources_omitted || 0;
        parts.push(`${changeSummary.modules_omitted} additional change group(s) (${resources} resource(s)) were not analyzed in detail due to capacity limits (the ${changeSummary.modules_analyzed} highest-impact groups were prioritized)`);
    }
    if (changeSummary.cosmetic_omitted > 0) {
        parts.push(`${changeSummary.cosmetic_omitted} cosmetic tag-only change(s) were skipped as low-impact`);
    }
    return parts.length ? `${parts.join('; ')}.` : null;
}

// Distribution phase: resolve the shared context once, then dispatch the analysis
// to every configured channel independently. Only runs for fresh analyses; cached
// replays are short-circuited earlier since every channel was already delivered.
async function distribute(analysis, httpClient, event, changeSummary, payloadModules) {
    const failOnError = core.getInput('fail_on_error', { required: false }) === 'true';
    const capacityNotice = buildCapacityNotice(changeSummary);
    const analysisView = { ...analysis, modules: enrichModules(analysis, payloadModules) };

    const jiraCfg = {
        baseUrl: core.getInput('jira_base_url', { required: false }),
        email: core.getInput('jira_email', { required: false }),
        apiToken: core.getInput('jira_api_token', { required: false }),
    };
    const issueKeys = resolveIssueKeys(event);
    const jiraActive = Boolean(jiraCfg.baseUrl && jiraCfg.email && jiraCfg.apiToken && issueKeys.length);
    const jiraLink = jiraActive ? `${jiraCfg.baseUrl.replace(/\/+$/, '')}/browse/${issueKeys[0]}` : null;

    const slackWebhook = core.getInput('slack_webhook_url', { required: false });

    const prCommentEnabled = core.getInput('pr_comment', { required: false }) === 'true';
    const githubToken = core.getInput('github_token', { required: false }) || process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    const prNumber = event.pull_request && event.pull_request.number;
    const prMeta = {
        prUrl: event.pull_request && event.pull_request.html_url,
        author: event.pull_request && event.pull_request.user && event.pull_request.user.login,
        repo,
    };

    // 1) Jira (upsert to every resolved issue key, each independent)
    await deliver('Jira', jiraActive, async () => {
        const adf = jira.buildAdf(analysisView, capacityNotice);
        for (const key of issueKeys) {
            try {
                await jira.upsertComment(httpClient, { ...jiraCfg, issueKey: key, adf });
                core.info(`Posted analysis to Jira issue ${key}.`);
            } catch (error) {
                if (failOnError) {
                    throw error;
                }
                core.warning(`Jira delivery failed for ${key}: ${error.message}`);
            }
        }
    }, failOnError);
    if (!jiraActive) {
        core.info('Jira delivery skipped (missing config or no issue key).');
    }

    // 2) Slack (cross-links to Jira when active)
    await deliver('Slack', Boolean(slackWebhook), async () => {
        const message = slack.buildMessage(analysisView, { jiraLink, capacityNotice, ...prMeta });
        await slack.send(httpClient, slackWebhook, message);
        core.info('Posted analysis to Slack.');
    }, failOnError);
    if (!slackWebhook) {
        core.info('Slack delivery skipped (no slack_webhook_url).');
    }

    // 3) GitHub PR comment (upsert)
    const prActive = Boolean(prCommentEnabled && prNumber && githubToken && repo);
    await deliver('GitHub PR', prActive, async () => {
        const body = github.buildMarkdown(analysisView, { jiraLink, capacityNotice });
        await github.upsertComment(httpClient, { token: githubToken, repo, prNumber, body });
        core.info(`Upserted PR comment on #${prNumber}.`);
    }, failOnError);
    if (prCommentEnabled && !prActive) {
        core.info('PR comment skipped (no pull_request context or missing github_token).');
    }
}

// Entry point: runs the analysis phase and then the distribution phase.
async function run() {
    try {
        const httpClient = new HttpClient('terraform2jira-action');
        const analysisResult = await analyzePlan(httpClient);
        if (!analysisResult) {
            return;
        }
        const { result, changeSummary, payloadModules } = analysisResult;

        core.info(`Backend response:\n${JSON.stringify(result, null, 2)}`);

        if (result.metadata && result.metadata.cached) {
            core.info('Cached result (idempotent replay): channels already notified on the first run; skipping delivery.');
        } else if (result.analysis) {
            await distribute(result.analysis, httpClient, readEvent(), changeSummary, payloadModules);
        }

        await core.summary
            .addHeading('Terraform → Business Translator')
            .addCodeBlock(JSON.stringify(result, null, 2), 'json')
            .write();
    } catch (error) {
        core.setFailed(error.message);
    }
}

module.exports = {
    run,
    // Exported for unit testing (pure, side-effect-free helpers).
    buildReducedPayload,
    changedAttributes,
    changedTagKeys,
    buildCapacityNotice,
    groupKey,
    blockAddress,
    enrichModules,
};
