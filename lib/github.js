// GitHub PR comment integration: renders the business analysis as Markdown and
// upserts a single bot comment on the pull request (no thread spam).

const MARKER = '<!-- terraform2jira -->';
const SEVERITY_EMOJI = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };

function buildMarkdown(analysis, context) {
    const severity = String(analysis.severity || 'unknown').toLowerCase();
    const lines = [
        '### 🗿 Terraform → Business Impact',
        '',
        analysis.summary || '',
        '',
        `**Severity:** ${SEVERITY_EMOJI[severity] || ''} ${severity}  |  **Cost impact:** ${analysis.cost_impact || 'unknown'}`,
    ];

    if (context && context.capacityNotice) {
        lines.push('', `> ℹ️ ${context.capacityNotice}`);
    }

    if (Array.isArray(analysis.modules) && analysis.modules.length) {
        lines.push('', '**Changes**');
        analysis.modules.forEach((mod) => {
            if (mod.is_module) {
                const header = mod.action_summary ? `${mod.module} — ${mod.action_summary}` : mod.module;
                lines.push('', `**${header}**`);
                if (mod.business_impact) lines.push(mod.business_impact);
                (mod.resources || []).forEach((r) => lines.push(`- \`${r.label}\``));
            } else {
                const r = (mod.resources && mod.resources[0]) || { label: mod.module };
                lines.push('', `**\`${r.label}\`**`);
                if (mod.business_impact) lines.push(mod.business_impact);
            }
            if (mod.risk) lines.push(`_Risk: ${mod.risk}_`);
        });
    }

    if (Array.isArray(analysis.risks) && analysis.risks.length) {
        lines.push('', '**Risks**');
        analysis.risks.forEach((r) => lines.push(`- ${r}`));
    }

    if (Array.isArray(analysis.recommendations) && analysis.recommendations.length) {
        lines.push('', '**Recommendations**');
        analysis.recommendations.forEach((r) => lines.push(`- ${r}`));
    }

    if (context && context.jiraLink) {
        lines.push('', `🔗 [View ticket in Jira](${context.jiraLink})`);
    }

    return lines.join('\n');
}

function apiHeaders(token) {
    return {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'terraform2jira-action',
    };
}

// Finds the existing bot comment (by marker) and updates it, or creates a new one.
async function upsertComment(httpClient, { token, repo, prNumber, body }) {
    const base = process.env.GITHUB_API_URL || 'https://api.github.com';
    const headers = apiHeaders(token);
    const fullBody = `${body}\n\n${MARKER}`;

    const listUrl = `${base}/repos/${repo}/issues/${prNumber}/comments?per_page=100`;
    const listRes = await httpClient.getJson(listUrl, headers);
    const existing = Array.isArray(listRes.result)
        ? listRes.result.find((comment) => comment.body && comment.body.includes(MARKER))
        : null;

    const url = existing
        ? `${base}/repos/${repo}/issues/comments/${existing.id}`
        : `${base}/repos/${repo}/issues/${prNumber}/comments`;

    const response = existing
        ? await httpClient.patchJson(url, { body: fullBody }, headers)
        : await httpClient.postJson(url, { body: fullBody }, headers);

    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`GitHub responded with status ${response.statusCode}`);
    }
}

module.exports = { buildMarkdown, upsertComment };
