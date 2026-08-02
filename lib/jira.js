const SEVERITY_EMOJI = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };
const COST_ARROW = { increase: '↑', decrease: '↓', neutral: '→' };
const MARKER = 'Posted by terraform2jira';

// projectKeys scopes the match to real prefixes, avoiding false positives like "UTF-8".
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

function buildAdf(analysis, capacityNotice) {
    const content = [heading(3, '🗿 Terraform → Business Impact')];

    if (analysis.summary) {
        content.push(paragraph(textNode(analysis.summary)));
    }

    const severity = String(analysis.severity || 'unknown').toLowerCase();
    const cost = String(analysis.cost_impact || 'unknown').toLowerCase();
    const costText = COST_ARROW[cost] ? `${COST_ARROW[cost]} ${cost}` : cost;
    content.push(paragraph([
        strongNode('Severity: '),
        textNode(`${SEVERITY_EMOJI[severity] || ''} ${severity}`),
        textNode('    ·    '),
        strongNode('Cost: '),
        textNode(costText),
    ]));

    if (Array.isArray(analysis.risks) && analysis.risks.length) {
        content.push(heading(4, 'Risks'));
        content.push(bulletList(analysis.risks.map((risk) => textNode(risk))));
    }

    if (Array.isArray(capacityNotice)) {
        for (const notice of capacityNotice) {
            content.push(paragraph({ type: 'text', text: `${notice.icon} ${notice.text}`, marks: [{ type: 'em' }] }));
        }
    }

    if (analysis.overview) {
        content.push(paragraph([strongNode('Overview: '), textNode(analysis.overview)]));
    }

    if (Array.isArray(analysis.recommendations) && analysis.recommendations.length) {
        content.push(heading(4, 'Recommendations'));
        content.push(bulletList(analysis.recommendations.map((rec) => textNode(rec))));
    }

    if (Array.isArray(analysis.modules) && analysis.modules.length) {
        const details = [];
        if (analysis.tfLegend) {
            details.push(paragraph({ type: 'text', text: analysis.tfLegend, marks: [{ type: 'em' }] }));
        }
        analysis.modules.forEach((mod, i) => {
            if (i > 0) details.push({ type: 'rule' });
            if (mod.name) details.push(paragraph([strongNode(mod.name)]));
            if (mod.business_impact) {
                details.push(paragraph(textNode(mod.business_impact)));
            }
            if (mod.tf && mod.tf.length) {
                details.push({ type: 'codeBlock', attrs: { language: 'diff' }, content: [textNode(mod.tf.join('\n'))] });
            }
            if (mod.risk) {
                details.push(paragraph([strongNode('Risk: '), textNode(mod.risk)]));
            }
        });
        content.push({ type: 'expand', attrs: { title: 'Details — resource changes' }, content: details });
    }

    return { version: 1, type: 'doc', content };
}

let cachedTimeZone;

async function fetchTimeZone(httpClient, base, headers) {
    if (cachedTimeZone) {
        return cachedTimeZone;
    }
    try {
        const res = await httpClient.getJson(`${base}/rest/api/3/myself`, headers);
        cachedTimeZone = (res.result && res.result.timeZone) || 'UTC';
    } catch (error) {
        cachedTimeZone = 'UTC';
    }
    return cachedTimeZone;
}

function footerNodes(timeZone) {
    const stamp = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
    return [
        { type: 'rule' },
        {
            type: 'paragraph',
            content: [{
                type: 'text',
                text: `${MARKER} • updated ${stamp} (${timeZone})`,
                marks: [{ type: 'em' }],
            }],
        },
    ];
}

async function upsertComment(httpClient, { baseUrl, email, apiToken, issueKey, adf }) {
    const base = baseUrl.replace(/\/+$/, '');
    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };

    const timeZone = await fetchTimeZone(httpClient, base, headers);
    const body = { ...adf, content: [...adf.content, ...footerNodes(timeZone)] };

    const listUrl = `${base}/rest/api/3/issue/${issueKey}/comment?orderBy=-created&maxResults=50`;
    const listRes = await httpClient.getJson(listUrl, headers);
    const comments = (listRes.result && listRes.result.comments) || [];
    const existing = comments.find((comment) => JSON.stringify(comment.body || '').includes(MARKER));

    const url = existing
        ? `${base}/rest/api/3/issue/${issueKey}/comment/${existing.id}`
        : `${base}/rest/api/3/issue/${issueKey}/comment`;
    const response = existing
        ? await httpClient.putJson(url, { body }, headers)
        : await httpClient.postJson(url, { body }, headers);

    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Jira responded with status ${response.statusCode}: ${JSON.stringify(response.result)}`);
    }

    return response.result;
}

module.exports = { extractIssueKeys, buildAdf, upsertComment };
