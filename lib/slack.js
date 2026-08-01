// Slack integration: renders the business analysis as Block Kit and posts it to
// an Incoming Webhook. A severity-colored attachment wraps the blocks.

const SEVERITY_COLOR = { low: '#2eb67d', medium: '#ecb22e', high: '#e8912d', critical: '#e01e5a' };
const SEVERITY_EMOJI = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };

function truncate(value, max) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function section(text) {
    return { type: 'section', text: { type: 'mrkdwn', text: truncate(text, 3000) } };
}

function buildBlocks(analysis, context) {
    const severity = String(analysis.severity || 'unknown').toLowerCase();
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: '🗿 Terraform → Business Impact', emoji: true } },
    ];

    if (analysis.summary) {
        blocks.push(section(analysis.summary));
    }

    blocks.push({
        type: 'section',
        fields: [
            { type: 'mrkdwn', text: `*Severity:*\n${SEVERITY_EMOJI[severity] || ''} ${severity}` },
            { type: 'mrkdwn', text: `*Cost impact:*\n${analysis.cost_impact || 'unknown'}` },
        ],
    });

    if (context.capacityNotice) {
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `ℹ️ ${context.capacityNotice}` }] });
    }

    if (Array.isArray(analysis.modules) && analysis.modules.length) {
        for (const mod of analysis.modules) {
            const lines = [];
            if (mod.is_module) {
                const header = mod.action_summary ? `${mod.module} — ${mod.action_summary}` : mod.module;
                lines.push(`*${header}*`);
                if (mod.business_impact) lines.push(mod.business_impact);
                const resList = (mod.resources || [])
                    .map((r) => `• \`${r.label}\``)
                    .join('\n');
                if (resList) lines.push(resList);
            } else {
                const r = (mod.resources && mod.resources[0]) || { label: mod.module };
                lines.push(`*\`${r.label}\`*`);
                if (mod.business_impact) lines.push(mod.business_impact);
            }
            if (mod.risk) lines.push(`*Risk:* ${mod.risk}`);
            blocks.push(section(lines.join('\n')));
        }
    }

    if (Array.isArray(analysis.risks) && analysis.risks.length) {
        blocks.push(section(`*Risks*\n${analysis.risks.map((r) => `• ${r}`).join('\n')}`));
    }

    if (Array.isArray(analysis.recommendations) && analysis.recommendations.length) {
        blocks.push(section(`*Recommendations*\n${analysis.recommendations.map((r) => `• ${r}`).join('\n')}`));
    }

    // URL button linking to the Jira ticket (works with Incoming Webhooks)
    if (context.jiraLink) {
        blocks.push({
            type: 'actions',
            elements: [{
                type: 'button',
                text: { type: 'plain_text', text: 'Ver ticket en Jira', emoji: true },
                url: context.jiraLink,
                style: 'primary',
            }],
        });
    }

    const contextParts = [];
    if (context.repo) contextParts.push(context.repo);
    if (context.author) contextParts.push(`by ${context.author}`);
    if (context.prUrl) contextParts.push(`<${context.prUrl}|View PR>`);
    if (contextParts.length) {
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: contextParts.join('  •  ') }] });
    }

    return blocks;
}

function buildMessage(analysis, context) {
    const severity = String(analysis.severity || 'unknown').toLowerCase();
    return {
        attachments: [{
            color: SEVERITY_COLOR[severity] || '#cccccc',
            blocks: buildBlocks(analysis, context),
        }],
    };
}

// Posts the message to a Slack Incoming Webhook. Throws on non-2xx responses.
async function send(httpClient, webhookUrl, message) {
    const response = await httpClient.post(webhookUrl, JSON.stringify(message), {
        'Content-Type': 'application/json',
    });
    const body = await response.readBody();
    const status = response.message.statusCode;
    if (status < 200 || status >= 300) {
        throw new Error(`Slack responded with status ${status}: ${body}`);
    }
}

module.exports = { buildMessage, send };
