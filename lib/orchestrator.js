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

// Ranks changes so the most destructive survive truncation (delete/replace first).
function actionRank(actions) {
    if (actions.includes('delete')) return 0; // delete or replace
    if (actions.includes('create')) return 1;
    return 2; // update / other
}

// Builds the reduced, sanitized payload sent to the backend (DLP applied here):
// only non-sensitive metadata leaves the runner. no-op/read are dropped, tag-only
// changes are bundled as a count, and only the highest-impact changes (capped) are
// sent for detailed analysis.
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

    // Prioritize the most destructive changes; the backend slices the top N to
    // analyze (MAX_ANALYZED_RESOURCES env var) and owns the payload ceiling, so all
    // scaling knobs stay server-side. The client sends every significant change.
    significant.sort((a, b) => actionRank(a.actions) - actionRank(b.actions));

    const changedResources = significant.map(({ resource, actions, changed }) => {
        const entry = {
            address: resource.address,
            type: resource.type,
            name: resource.name,
            change: { actions },
        };
        if (changed && changed.length > 0) {
            entry.changed = changed;
        }
        if (resource.action_reason) {
            entry.action_reason = resource.action_reason;
        }
        const replacePaths = resource.change && resource.change.replace_paths;
        if (Array.isArray(replacePaths) && replacePaths.length > 0) {
            entry.replace_triggered_by = [...new Set(
                replacePaths
                    .map((path) => (Array.isArray(path) ? path[0] : path))
                    .filter((step) => typeof step === 'string')
            )];
        }
        return entry;
    });

    return {
        payload: {
            format_version: plan.format_version,
            terraform_version: plan.terraform_version,
            resource_changes: changedResources,
            // The backend caps how many of these are analyzed and computes the final
            // analyzed/omitted counts; it only needs the true totals from the client.
            change_summary: {
                total_changes: significant.length + cosmeticCount,
                cosmetic_omitted: cosmeticCount,
                significant_total: significant.length,
            },
        },
        significantCount: significant.length,
        cosmeticCount,
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
    const { payload, significantCount, cosmeticCount, totalCount } = buildReducedPayload(plan, relevantTags);

    core.info(`Changes: ${significantCount} significant, ${cosmeticCount} cosmetic (tags), of ${totalCount} total.`);
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
    return { result: response.result, changeSummary };
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

// Builds a deterministic notice about changes the client could not send for
// detailed analysis (capacity cap / cosmetic noise). Null when nothing was omitted.
function buildCapacityNotice(changeSummary) {
    if (!changeSummary) {
        return null;
    }
    const parts = [];
    if (changeSummary.significant_omitted > 0) {
        parts.push(`${changeSummary.significant_omitted} additional significant change(s) were not analyzed in detail due to capacity limits (the ${changeSummary.analyzed} highest-impact changes were prioritized)`);
    }
    if (changeSummary.cosmetic_omitted > 0) {
        parts.push(`${changeSummary.cosmetic_omitted} cosmetic tag-only change(s) were skipped as low-impact`);
    }
    return parts.length ? `${parts.join('; ')}.` : null;
}

// Distribution phase: resolve the shared context once, then dispatch the analysis
// to every configured channel independently. Only runs for fresh analyses; cached
// replays are short-circuited earlier since every channel was already delivered.
async function distribute(analysis, httpClient, event, changeSummary) {
    const failOnError = core.getInput('fail_on_error', { required: false }) === 'true';
    const capacityNotice = buildCapacityNotice(changeSummary);

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
        const adf = jira.buildAdf(analysis, capacityNotice);
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
        const message = slack.buildMessage(analysis, { jiraLink, capacityNotice, ...prMeta });
        await slack.send(httpClient, slackWebhook, message);
        core.info('Posted analysis to Slack.');
    }, failOnError);
    if (!slackWebhook) {
        core.info('Slack delivery skipped (no slack_webhook_url).');
    }

    // 3) GitHub PR comment (upsert)
    const prActive = Boolean(prCommentEnabled && prNumber && githubToken && repo);
    await deliver('GitHub PR', prActive, async () => {
        const body = github.buildMarkdown(analysis, { jiraLink, capacityNotice });
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
        const { result, changeSummary } = analysisResult;

        core.info(`Backend response:\n${JSON.stringify(result, null, 2)}`);

        if (result.metadata && result.metadata.cached) {
            core.info('Cached result (idempotent replay): channels already notified on the first run; skipping delivery.');
        } else if (result.analysis) {
            await distribute(result.analysis, httpClient, readEvent(), changeSummary);
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
};
