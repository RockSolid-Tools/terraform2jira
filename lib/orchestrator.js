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

// Builds the reduced, sanitized payload sent to the backend (DLP applied here):
// only non-sensitive metadata leaves the runner, and no-op/read resources are dropped.
function buildReducedPayload(plan) {
    const resourceChanges = Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
    const changedResources = resourceChanges
        .filter((resource) => {
            const actions = resource.change && resource.change.actions;
            if (!Array.isArray(actions)) {
                return false;
            }
            const onlyAction = actions.length === 1 ? actions[0] : null;
            return onlyAction !== 'no-op' && onlyAction !== 'read';
        })
        .map((resource) => ({
            address: resource.address,
            type: resource.type,
            name: resource.name,
            change: { actions: resource.change.actions },
        }));

    return {
        payload: {
            format_version: plan.format_version,
            terraform_version: plan.terraform_version,
            resource_changes: changedResources,
        },
        changedCount: changedResources.length,
        totalCount: resourceChanges.length,
    };
}

// Analysis phase: read the plan, reduce/sanitize it, authenticate via OIDC and
// send it to the backend. Returns the parsed backend response.
async function analyzePlan(httpClient) {
    const planPath = core.getInput('plan_path', { required: true });
    const apiUrl = core.getInput('api_url', { required: false });
    const audience = core.getInput('audience', { required: false });

    core.info(`Reading Terraform plan from: ${planPath}`);
    if (!fs.existsSync(planPath)) {
        throw new Error(`Plan file not found at "${planPath}".`);
    }

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const { payload, changedCount, totalCount } = buildReducedPayload(plan);

    core.info(`Found ${changedCount} changing resource(s) out of ${totalCount}.`);
    core.info(`Reduced plan sent to backend:\n${JSON.stringify(payload, null, 2)}`);
    core.setOutput('reduced_plan', JSON.stringify(payload));

    if (changedCount === 0) {
        core.info('No infrastructure changes to analyze. Skipping backend call.');
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
    return response.result;
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

// Distribution phase: resolve the shared context once, then dispatch the analysis
// to every configured channel independently.
async function distribute(analysis, httpClient, event) {
    const failOnError = core.getInput('fail_on_error', { required: false }) === 'true';

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

    // 1) Jira (post to every resolved issue key, each independent)
    await deliver('Jira', jiraActive, async () => {
        const adf = jira.buildAdf(analysis);
        for (const key of issueKeys) {
            try {
                await jira.postComment(httpClient, { ...jiraCfg, issueKey: key, adf });
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
        const message = slack.buildMessage(analysis, { jiraLink, ...prMeta });
        await slack.send(httpClient, slackWebhook, message);
        core.info('Posted analysis to Slack.');
    }, failOnError);
    if (!slackWebhook) {
        core.info('Slack delivery skipped (no slack_webhook_url).');
    }

    // 3) GitHub PR comment (upsert)
    const prActive = Boolean(prCommentEnabled && prNumber && githubToken && repo);
    await deliver('GitHub PR', prActive, async () => {
        const body = github.buildMarkdown(analysis, { jiraLink });
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
        const result = await analyzePlan(httpClient);
        if (!result) {
            return;
        }

        core.info(`Backend response:\n${JSON.stringify(result, null, 2)}`);

        if (result && result.analysis) {
            await distribute(result.analysis, httpClient, readEvent());
        }

        await core.summary
            .addHeading('Terraform → Business Translator')
            .addCodeBlock(JSON.stringify(result, null, 2), 'json')
            .write();
    } catch (error) {
        core.setFailed(error.message);
    }
}

module.exports = { run };
