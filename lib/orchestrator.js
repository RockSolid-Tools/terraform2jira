const fs = require('fs');
const core = require('@actions/core');
const { HttpClient } = require('@actions/http-client');
const jira = require('./jira');
const slack = require('./slack');
const github = require('./github');

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

const COSMETIC_ATTRS = new Set(['tags', 'tags_all']);

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// Changed top-level attribute names only — no values leave the runner (DLP).
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

// Changed tag key names only, never values (DLP).
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

function blockAddress(resource) {
    if (resource.type && resource.name) {
        const prefix = resource.module_address ? `${resource.module_address}.` : '';
        return `${prefix}${resource.type}.${resource.name}`;
    }
    return resource.address;
}

function groupKey(resource) {
    return resource.module_address || blockAddress(resource);
}

function categorizeAction(actions) {
    const hasDelete = actions.includes('delete');
    const hasCreate = actions.includes('create');
    if (hasDelete && hasCreate) return 'replace';
    if (hasDelete) return 'delete';
    if (hasCreate) return 'create';
    return 'update';
}

function breakdownRank(breakdown) {
    if (breakdown.replace + breakdown.delete > 0) return 0;
    if (breakdown.create > 0) return 1;
    if (breakdown.import > 0) return 2;
    return 3;
}

// DLP boundary: only non-sensitive metadata (names, never values) leaves the runner.
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
        // Imports (change.importing) are surfaced as an import action; the id is never sent (DLP).
        const importing = Boolean(change.importing);
        const onlyAction = actions.length === 1 ? actions[0] : null;
        if ((onlyAction === 'no-op' || onlyAction === 'read') && !importing) {
            continue;
        }

        if (onlyAction === 'update') {
            const changed = changedAttributes(change);
            const tagOnly = changed.length > 0 && changed.every((attr) => COSMETIC_ATTRS.has(attr));
            if (tagOnly) {
                const relevantChanged = relevantTags.length
                    ? changedTagKeys(change).filter((key) => relevantTags.includes(key))
                    : [];
                if (relevantChanged.length === 0 && !importing) {
                    cosmeticCount += 1;
                    continue;
                }
                significant.push({ resource, actions, changed: relevantChanged.map((key) => `tags.${key}`), importing });
                continue;
            }
            significant.push({ resource, actions, changed, importing });
        } else {
            // Replaces carry their changed attribute NAMES too (DLP-safe) so the LLM can
            // explain what forced the recreation; create/delete/import have no meaningful diff.
            const isReplace = actions.includes('delete') && actions.includes('create');
            significant.push({ resource, actions, changed: isReplace ? changedAttributes(change) : null, importing });
        }
    }

    const groups = new Map();
    for (const { resource, actions, changed, importing } of significant) {
        const key = groupKey(resource);
        if (!groups.has(key)) {
            groups.set(key, {
                module: key,
                is_module: Boolean(resource.module_address),
                action_breakdown: { replace: 0, delete: 0, create: 0, import: 0, update: 0 },
                entries: new Map(),
            });
        }
        const group = groups.get(key);
        const category = importing ? 'import' : categorizeAction(actions);
        group.action_breakdown[category] += 1;

        const block = blockAddress(resource);
        if (!group.entries.has(block)) {
            group.entries.set(block, {
                address: block,
                first_address: resource.address,
                type: resource.type,
                name: resource.name,
                instances: 0,
                action_breakdown: { replace: 0, delete: 0, create: 0, import: 0, update: 0 },
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

    modules.sort((a, b) => {
        const da = a.action_breakdown.replace + a.action_breakdown.delete;
        const db = b.action_breakdown.replace + b.action_breakdown.delete;
        if (da !== db) return db - da;
        if (a.action_breakdown.create !== b.action_breakdown.create) {
            return b.action_breakdown.create - a.action_breakdown.create;
        }
        if (a.action_breakdown.import !== b.action_breakdown.import) {
            return b.action_breakdown.import - a.action_breakdown.import;
        }
        return b.action_breakdown.update - a.action_breakdown.update;
    });

    return {
        payload: {
            format_version: plan.format_version,
            terraform_version: plan.terraform_version,
            modules,
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

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// User-facing message per status; raw detail goes to debug only (never leaks).
function friendlyBackendError(status, result) {
    switch (status) {
        case 401:
            return 'Backend authentication failed. Ensure the workflow grants `permissions: id-token: write` and the `audience` input matches the backend.';
        case 402:
            return 'Your organization has reached its monthly analysis quota. Upgrade your plan to keep receiving summaries.';
        case 403:
            return 'This repository is not allowed to run analyses (inactive or no active plan).';
        case 413:
            return 'The Terraform plan is too large to analyze in a single request.';
        default:
            if (status === 429 || status >= 500) {
                return 'The analysis service is temporarily unavailable. Please try again later.';
            }
            return `The analysis service returned an unexpected error (status ${status}).`;
    }
}

// Safe to retry: backend is idempotent per commit and refunds quota on failure.
async function postWithRetry(httpClient, url, payload, headers, maxRetries = 2) {
    for (let attempt = 0; ; attempt += 1) {
        let status;
        let result;
        try {
            const response = await httpClient.postJson(url, payload, headers);
            status = response.statusCode;
            result = response.result;
            if (status >= 200 && status < 300) {
                return response;
            }
        } catch (error) {
            // postJson rejects with HttpClientError (carrying statusCode/result) on any
            // status > 299; a genuine network failure has no numeric statusCode.
            status = typeof error.statusCode === 'number' ? error.statusCode : 0;
            result = error.result;
            if (!status) {
                if (attempt < maxRetries) {
                    const waitMs = 2000 * (attempt + 1);
                    core.warning(`Backend request failed (${error.message}); retrying in ${waitMs}ms (retry ${attempt + 1}/${maxRetries}).`);
                    await sleep(waitMs);
                    continue;
                }
                core.debug(`Backend request error: ${error.message}`);
                throw new Error('Could not reach the analysis service. Please try again later.');
            }
        }
        if (RETRYABLE_STATUS.has(status) && attempt < maxRetries) {
            const waitMs = 2000 * (attempt + 1);
            core.warning(`Backend responded ${status}; retrying in ${waitMs}ms (retry ${attempt + 1}/${maxRetries}).`);
            await sleep(waitMs);
            continue;
        }
        core.debug(`Backend error ${status}: ${JSON.stringify(result)}`);
        throw new Error(friendlyBackendError(status, result));
    }
}

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

    const skippedCount = totalCount - significantCount - cosmeticCount;
    core.info(`Changes: ${significantCount} significant in ${moduleCount} group(s), ${cosmeticCount} cosmetic (tags), ${skippedCount} skipped (no-op/read); ${totalCount} total.`);
    core.info(`Reduced plan sent to backend:\n${JSON.stringify(payload, null, 2)}`);
    core.setOutput('reduced_plan', JSON.stringify(payload));

    if (significantCount === 0) {
        core.info('No business-impacting changes to analyze (only cosmetic/no-op). Skipping backend call.');
        return null;
    }

    const idToken = await core.getIDToken(audience);
    const response = await postWithRetry(httpClient, apiUrl, payload, {
        Authorization: `Bearer ${idToken}`,
    });

    core.info(`Plan summary sent successfully (status ${response.statusCode}).`);
    core.setOutput('response', JSON.stringify(response.result));
    const changeSummary = (response.result.metadata && response.result.metadata.change_summary) || null;
    return { result: response.result, changeSummary, payloadModules: payload.modules };
}

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

function breakdownLabel(breakdown) {
    const b = breakdown || {};
    const parts = [];
    if (b.replace) parts.push(`${b.replace} recreated`);
    if (b.delete) parts.push(`${b.delete} destroyed`);
    if (b.create) parts.push(`${b.create} created`);
    if (b.import) parts.push(`${b.import} imported`);
    if (b.update) parts.push(`${b.update} updated`);
    return parts.join(', ');
}

function overviewLine(payloadModules) {
    const modules = Array.isArray(payloadModules) ? payloadModules : [];
    const total = { replace: 0, delete: 0, create: 0, import: 0, update: 0 };
    for (const m of modules) {
        const bd = m.action_breakdown || {};
        total.replace += bd.replace || 0;
        total.delete += bd.delete || 0;
        total.create += bd.create || 0;
        total.import += bd.import || 0;
        total.update += bd.update || 0;
    }
    const parts = [];
    if (total.create) parts.push(`${total.create} created`);
    if (total.replace) parts.push(`${total.replace} recreated`);
    if (total.delete) parts.push(`${total.delete} destroyed`);
    if (total.import) parts.push(`${total.import} imported`);
    if (total.update) parts.push(`${total.update} updated`);
    if (!parts.length) {
        return '';
    }
    return parts.join(' \u00b7 ');
}

const TF_SYMBOL = { replace: '-/+', delete: '-', create: '+', import: '\u2192', update: '~' };
const TF_LEGEND = '+ create \u00b7 ~ update \u00b7 - destroy \u00b7 -/+ replace \u00b7 \u2192 import';

function resourceSymbol(breakdown) {
    const b = breakdown || {};
    if (b.replace) return TF_SYMBOL.replace;
    if (b.delete) return TF_SYMBOL.delete;
    if (b.create) return TF_SYMBOL.create;
    if (b.import) return TF_SYMBOL.import;
    return TF_SYMBOL.update;
}

// The "# ..." trailer of a terraform-style line: changed attr names, or the instance breakdown.
function tfComment(entry) {
    const bd = entry.action_breakdown || {};
    const instances = entry.instances || 1;
    const changed = Array.isArray(entry.changed) ? entry.changed : [];
    const changedText = changed.length
        ? `${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', \u2026' : ''}`
        : '';
    if (instances > 1) {
        const notable = [];
        if (entry.recreated_instances && entry.recreated_instances.length) notable.push(`recreated: ${entry.recreated_instances.join(', ')}`);
        if (entry.destroyed_instances && entry.destroyed_instances.length) notable.push(`destroyed: ${entry.destroyed_instances.join(', ')}`);
        if (changedText) notable.push(changedText);
        const base = `\u00d7${instances} ${breakdownLabel(bd)}`;
        return notable.length ? `${base} (${notable.join('; ')})` : base;
    }
    return changedText;
}

// Sub-resources read relative to their module heading, like a terraform plan.
function relativeAddress(address, prefix) {
    return prefix && address.startsWith(`${prefix}.`) ? address.slice(prefix.length + 1) : address;
}

function tfLine(entry, prefix) {
    const symbol = resourceSymbol(entry.action_breakdown);
    const addr = relativeAddress(entry.address, prefix);
    const comment = tfComment(entry);
    return comment ? `${symbol} ${addr}  # ${comment}` : `${symbol} ${addr}`;
}

// Total detail budget sized to keep the rendered message under Jira's ~32KB limit.
const MAX_TOTAL_RENDERED_RESOURCES = 150;
const MAX_RENDERED_RESOURCES_PER_MODULE = 30;

function allocateRenderBudget(counts, total, perModuleMax) {
    const limits = counts.map(() => 0);
    let remaining = Math.min(total, counts.reduce((s, c) => s + Math.min(c, perModuleMax), 0));
    let granted = true;
    while (remaining > 0 && granted) {
        granted = false;
        for (let i = 0; i < counts.length && remaining > 0; i += 1) {
            if (limits[i] < Math.min(counts[i], perModuleMax)) {
                limits[i] += 1;
                remaining -= 1;
                granted = true;
            }
        }
    }
    return limits;
}

function tfLines(resources, prefix, limit) {
    const shown = resources.slice(0, limit).map((r) => tfLine(r, prefix));
    const hidden = resources.length - shown.length;
    if (hidden > 0) shown.push(`# +${hidden} more`);
    return shown;
}

function enrichModules(analysis, payloadModules) {
    const byName = new Map((payloadModules || []).map((m) => [m.module, m]));
    const llmModules = Array.isArray(analysis.modules) ? analysis.modules : [];
    const datas = llmModules.map((m) => byName.get(m.module) || { resources: [], action_breakdown: {}, is_module: false });
    const counts = datas.map((d) => (d.is_module && Array.isArray(d.resources) ? d.resources.length : 0));
    const limits = allocateRenderBudget(counts, MAX_TOTAL_RENDERED_RESOURCES, MAX_RENDERED_RESOURCES_PER_MODULE);
    return llmModules.map((m, idx) => {
        const data = datas[idx];
        const isModule = Boolean(data.is_module);
        const resources = Array.isArray(data.resources) ? data.resources : [];
        return {
            module: m.module,
            is_module: isModule,
            business_impact: m.business_impact,
            risk: m.risk,
            name: isModule ? m.module : null,
            tf: isModule
                ? tfLines(resources, m.module, limits[idx])
                : (resources[0] ? [tfLine(resources[0], null)] : []),
        };
    });
}

function buildCapacityNotice(changeSummary) {
    if (!changeSummary) {
        return null;
    }
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const notices = [];
    if (changeSummary.modules_omitted > 0) {
        const resources = changeSummary.resources_omitted || 0;
        const was = changeSummary.modules_omitted === 1 ? 'was' : 'were';
        notices.push({
            icon: 'ℹ️',
            text: `${count(changeSummary.modules_omitted, 'lower-impact change group')} (${count(resources, 'resource')}) ${was} not detailed — the ${changeSummary.modules_analyzed} highest-impact groups were prioritized.`,
        });
    }
    if (changeSummary.cosmetic_omitted > 0) {
        const was = changeSummary.cosmetic_omitted === 1 ? 'was' : 'were';
        notices.push({
            icon: '🏷️',
            text: `${count(changeSummary.cosmetic_omitted, 'cosmetic tag-only change')} ${was} skipped as low-impact.`,
        });
    }
    return notices.length ? notices : null;
}

async function distribute(analysis, httpClient, event, changeSummary, payloadModules) {
    const failOnError = core.getInput('fail_on_error', { required: false }) === 'true';
    const capacityNotice = buildCapacityNotice(changeSummary);
    const analysisView = { ...analysis, modules: enrichModules(analysis, payloadModules), overview: overviewLine(payloadModules), tfLegend: TF_LEGEND };

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

    await deliver('Slack', Boolean(slackWebhook), async () => {
        const message = slack.buildMessage(analysisView, { jiraLink, capacityNotice, ...prMeta });
        await slack.send(httpClient, slackWebhook, message);
        core.info('Posted analysis to Slack.');
    }, failOnError);
    if (!slackWebhook) {
        core.info('Slack delivery skipped (no slack_webhook_url).');
    }

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
    buildReducedPayload,
    changedAttributes,
    changedTagKeys,
    buildCapacityNotice,
    groupKey,
    blockAddress,
    enrichModules,
    overviewLine,
    postWithRetry,
    friendlyBackendError,
};
