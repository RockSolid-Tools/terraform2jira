// Jira Cloud integration: builds an Atlassian Document Format (ADF) comment
// from the business analysis and posts it to the issue's comment endpoint.

const SEVERITY_EMOJI = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };

// Extracts unique Jira issue keys (e.g. "PROJ-123") from a text.
// When projectKeys is a non-empty array, only keys with those project prefixes
// match, which avoids false positives like "UTF-8" or "HTTP-2".
function extractIssueKeys(text, projectKeys) {
    if (!text) {
        return [];
    }
    const prefixes = Array.isArray(projectKeys) ? projectKeys.filter(Boolean) : [];
    const pattern = prefixes.length
        ? new RegExp(`\\b(?:${prefixes.join('|')})-\\d+\\b`, 'g')
        : /\b[A-Z][A-Z0-9]+-\d+\b/g;
    return [...new Set(text.match(pattern) || [])];
}

function textNode(value) {
    return { type: 'text', text: String(value) };
}

function strongNode(value) {
    return { type: 'text', text: String(value), marks: [{ type: 'strong' }] };
}

function paragraph(children) {
    return { type: 'paragraph', content: Array.isArray(children) ? children : [children] };
}

function heading(level, value) {
    return { type: 'heading', attrs: { level }, content: [textNode(value)] };
}

function bulletList(itemsContent) {
    return {
        type: 'bulletList',
        content: itemsContent.map((children) => ({
            type: 'listItem',
            content: [paragraph(children)],
        })),
    };
}

// Builds the ADF document representing the analysis.
function buildAdf(analysis) {
    const content = [heading(3, '🗿 Terraform → Business Impact')];

    if (analysis.summary) {
        content.push(paragraph(textNode(analysis.summary)));
    }

    const severity = String(analysis.severity || 'unknown').toLowerCase();
    content.push(paragraph([
        strongNode('Severity: '),
        textNode(`${SEVERITY_EMOJI[severity] || ''} ${severity}`),
        textNode('    |    '),
        strongNode('Cost impact: '),
        textNode(analysis.cost_impact || 'unknown'),
    ]));

    if (Array.isArray(analysis.resources) && analysis.resources.length) {
        content.push(heading(4, 'Resources'));
        content.push(bulletList(analysis.resources.map((resource) => ([
            strongNode(`${resource.address} (${resource.action}): `),
            textNode(resource.business_impact || ''),
        ]))));
    }

    if (Array.isArray(analysis.risks) && analysis.risks.length) {
        content.push(heading(4, 'Risks'));
        content.push(bulletList(analysis.risks.map((risk) => textNode(risk))));
    }

    if (Array.isArray(analysis.recommendations) && analysis.recommendations.length) {
        content.push(heading(4, 'Recommendations'));
        content.push(bulletList(analysis.recommendations.map((rec) => textNode(rec))));
    }

    return { version: 1, type: 'doc', content };
}

// Posts the ADF comment to the Jira issue. Throws on non-2xx responses.
async function postComment(httpClient, { baseUrl, email, apiToken, issueKey, adf }) {
    const url = `${baseUrl.replace(/\/+$/, '')}/rest/api/3/issue/${issueKey}/comment`;
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const response = await httpClient.postJson(url, { body: adf }, {
        Authorization: `Basic ${auth}`,
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Jira responded with status ${response.statusCode}: ${JSON.stringify(response.result)}`);
    }

    return response.result;
}

module.exports = { extractIssueKeys, buildAdf, postComment };
