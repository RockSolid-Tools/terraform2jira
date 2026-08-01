const MARKER = '<!-- terraform2jira -->';
const SEVERITY_EMOJI = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };
const COST_ARROW = { increase: '↑', decrease: '↓', neutral: '→' };

function buildMarkdown(analysis, context) {
    const severity = String(analysis.severity || 'unknown').toLowerCase();
    const cost = String(analysis.cost_impact || 'unknown').toLowerCase();
    const costText = COST_ARROW[cost] ? `${COST_ARROW[cost]} ${cost}` : cost;
    const lines = [
        '### 🗿 Terraform → Business Impact',
        '',
        analysis.summary || '',
        '',
        `**Severity:** ${SEVERITY_EMOJI[severity] || ''} ${severity}  ·  **Cost:** ${costText}`,
    ];

    if (Array.isArray(analysis.risks) && analysis.risks.length) {
        lines.push('', '**Risks**');
        analysis.risks.forEach((r) => lines.push(`- ${r}`));
    }

    if (analysis.overview) {
        lines.push('', `**Overview:** ${analysis.overview}`);
    }

    if (context && context.capacityNotice) {
        lines.push('', `> ℹ️ ${context.capacityNotice}`);
    }

    if (Array.isArray(analysis.recommendations) && analysis.recommendations.length) {
        lines.push('', '**Recommendations**');
        analysis.recommendations.forEach((r) => lines.push(`- ${r}`));
    }

    if (context && context.jiraLink) {
        lines.push('', `🔗 [View ticket in Jira](${context.jiraLink})`);
    }

    if (Array.isArray(analysis.modules) && analysis.modules.length) {
        lines.push('', '<details>', '<summary>Details — resource changes</summary>', '');
        analysis.modules.forEach((mod, i) => {
            if (i > 0) lines.push('', '---');
            lines.push('', mod.meta ? `**\`${mod.code}\`** ${mod.meta}` : `**\`${mod.code}\`**`);
            if (mod.business_impact) lines.push(mod.business_impact);
            (mod.resources || []).forEach((r) => lines.push(`- \`${r.code}\` ${r.meta}`));
            if (mod.risk) lines.push(`_Risk: ${mod.risk}_`);
        });
        lines.push('', '</details>');
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
