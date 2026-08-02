const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildReducedPayload,
    changedAttributes,
    changedTagKeys,
    buildCapacityNotice,
    groupKey,
    blockAddress,
    enrichModules,
    overviewLine,
} = require('../lib/orchestrator');

// Helper to build a resource_change entry quickly.
function resource(overrides) {
    return {
        address: 'aws_x.y',
        type: 'aws_x',
        name: 'y',
        change: { actions: ['update'] },
        ...overrides,
    };
}

function moduleByName(payload, name) {
    return payload.modules.find((m) => m.module === name);
}

test('buildReducedPayload: tag-only update is bundled as cosmetic, not sent', () => {
    const plan = {
        resource_changes: [
            resource({
                address: 'aws_s3_bucket.a', type: 'aws_s3_bucket', name: 'a',
                change: {
                    actions: ['update'],
                    before: { tags: { Owner: 'alice' } },
                    after: { tags: { Owner: 'bob' } },
                },
            }),
        ],
    };
    const { payload, significantCount, cosmeticCount } = buildReducedPayload(plan, []);
    assert.equal(significantCount, 0);
    assert.equal(cosmeticCount, 1);
    assert.equal(payload.modules.length, 0);
    assert.deepEqual(payload.change_summary, {
        total_changes: 1,
        cosmetic_omitted: 1,
        significant_total: 0,
        modules_total: 0,
    });
});

test('buildReducedPayload: tags_all-only update is also cosmetic', () => {
    const plan = {
        resource_changes: [
            resource({
                change: {
                    actions: ['update'],
                    before: { tags_all: { Env: 'dev' } },
                    after: { tags_all: { Env: 'prod' } },
                },
            }),
        ],
    };
    const { significantCount, cosmeticCount } = buildReducedPayload(plan, []);
    assert.equal(significantCount, 0);
    assert.equal(cosmeticCount, 1);
});

test('buildReducedPayload: relevant tag promotes a tag-only update to significant', () => {
    const plan = {
        resource_changes: [
            resource({
                address: 'aws_s3_bucket.a', type: 'aws_s3_bucket', name: 'a',
                change: {
                    actions: ['update'],
                    before: { tags: { Environment: 'dev', Owner: 'alice' } },
                    after: { tags: { Environment: 'prod', Owner: 'alice' } },
                },
            }),
        ],
    };
    const { payload, significantCount, cosmeticCount } = buildReducedPayload(plan, ['Environment']);
    assert.equal(significantCount, 1);
    assert.equal(cosmeticCount, 0);
    assert.equal(payload.modules.length, 1);
    assert.deepEqual(payload.modules[0].resources[0].changed, ['tags.Environment']);
});

test('buildReducedPayload: relevant_tags only promotes when the relevant key actually changed', () => {
    const plan = {
        resource_changes: [
            resource({
                change: {
                    actions: ['update'],
                    before: { tags: { Environment: 'prod', Owner: 'alice' } },
                    after: { tags: { Environment: 'prod', Owner: 'bob' } },
                },
            }),
        ],
    };
    const { significantCount, cosmeticCount } = buildReducedPayload(plan, ['Environment']);
    assert.equal(significantCount, 0);
    assert.equal(cosmeticCount, 1);
});

test('buildReducedPayload: no-op and read changes are discarded entirely', () => {
    const plan = {
        resource_changes: [
            resource({ change: { actions: ['no-op'] } }),
            resource({ change: { actions: ['read'] } }),
        ],
    };
    const { payload, significantCount, cosmeticCount, totalCount } = buildReducedPayload(plan, []);
    assert.equal(significantCount, 0);
    assert.equal(cosmeticCount, 0);
    assert.equal(totalCount, 2);
    assert.equal(payload.modules.length, 0);
    assert.equal(payload.change_summary.total_changes, 0);
});

test('buildReducedPayload: groups a module_address together; root resources are singletons', () => {
    const plan = {
        resource_changes: [
            resource({ address: 'module.cosmos.azurerm_cosmosdb_account.this', module_address: 'module.cosmos', type: 'azurerm_cosmosdb_account', name: 'this', change: { actions: ['create'] } }),
            resource({ address: 'module.cosmos.azurerm_private_endpoint.pe', module_address: 'module.cosmos', type: 'azurerm_private_endpoint', name: 'pe', change: { actions: ['create'] } }),
            resource({ address: 'aws_s3_bucket.logs', type: 'aws_s3_bucket', name: 'logs', change: { actions: ['create'] } }),
        ],
    };
    const { payload, moduleCount } = buildReducedPayload(plan, []);
    assert.equal(moduleCount, 2);
    const cosmos = moduleByName(payload, 'module.cosmos');
    assert.equal(cosmos.is_module, true);
    assert.equal(cosmos.resources.length, 2);
    assert.deepEqual(cosmos.action_breakdown, { replace: 0, delete: 0, create: 2, import: 0, update: 0 });
    const root = moduleByName(payload, 'aws_s3_bucket.logs');
    assert.equal(root.is_module, false);
    assert.equal(root.resources.length, 1);
});

test('buildReducedPayload: collapses count/for_each iterations into one entry with an instance count', () => {
    const plan = {
        resource_changes: ['a', 'b', 'c'].map((k) => resource({
            address: `azurerm_static_web_app.sites["${k}"]`,
            type: 'azurerm_static_web_app', name: 'sites', index: k,
            change: { actions: ['update'], before: { sku: 'Free' }, after: { sku: 'Standard' } },
        })),
    };
    const { payload, significantCount, moduleCount } = buildReducedPayload(plan, []);
    assert.equal(significantCount, 3);
    assert.equal(moduleCount, 1);
    const group = payload.modules[0];
    assert.equal(group.resources.length, 1);
    assert.equal(group.resources[0].address, 'azurerm_static_web_app.sites');
    assert.equal(group.resources[0].instances, 3);
    assert.deepEqual(group.resources[0].action_breakdown, { replace: 0, delete: 0, create: 0, import: 0, update: 3 });
});

test('buildReducedPayload: a single changed for_each instance keeps its indexed address', () => {
    const plan = {
        resource_changes: [
            resource({ address: 'azurerm_container_app.this["app3"]', type: 'azurerm_container_app', name: 'this', index: 'app3', change: { actions: ['update'], before: { env: 'a' }, after: { env: 'b' } } }),
        ],
    };
    const { payload } = buildReducedPayload(plan, []);
    const entry = payload.modules[0].resources[0];
    assert.equal(entry.address, 'azurerm_container_app.this["app3"]');
    assert.equal(entry.instances, 1);
});

test('buildReducedPayload: mixed actions across iterations are all preserved (a lone delete is not lost)', () => {
    const plan = {
        resource_changes: [
            resource({ address: 'azurerm_static_web_app.sites["a"]', type: 'azurerm_static_web_app', name: 'sites', index: 'a', change: { actions: ['update'], before: { s: 1 }, after: { s: 2 } } }),
            resource({ address: 'azurerm_static_web_app.sites["b"]', type: 'azurerm_static_web_app', name: 'sites', index: 'b', change: { actions: ['update'], before: { s: 1 }, after: { s: 2 } } }),
            resource({ address: 'azurerm_static_web_app.sites["gone"]', type: 'azurerm_static_web_app', name: 'sites', index: 'gone', change: { actions: ['delete'] } }),
        ],
    };
    const { payload } = buildReducedPayload(plan, []);
    const entry = payload.modules[0].resources[0];
    assert.equal(entry.instances, 3);
    assert.deepEqual(entry.action_breakdown, { replace: 0, delete: 1, create: 0, import: 0, update: 2 });
    assert.deepEqual(entry.destroyed_instances, ['gone']);
});

test('buildReducedPayload: unions changed/action_reason/replace_triggered_by across iterations', () => {
    const plan = {
        resource_changes: [
            resource({
                address: 'aws_instance.web[0]', type: 'aws_instance', name: 'web', index: 0,
                action_reason: 'replace_because_tainted',
                change: { actions: ['delete', 'create'], replace_paths: [['ami']] },
            }),
            resource({
                address: 'aws_instance.web[1]', type: 'aws_instance', name: 'web', index: 1,
                action_reason: 'replace_because_cannot_update',
                change: { actions: ['delete', 'create'], replace_paths: [['instance_type']] },
            }),
        ],
    };
    const { payload } = buildReducedPayload(plan, []);
    const entry = payload.modules[0].resources[0];
    assert.equal(entry.instances, 2);
    assert.deepEqual(entry.replace_triggered_by.sort(), ['ami', 'instance_type']);
    assert.deepEqual(entry.action_reason.sort(), ['replace_because_cannot_update', 'replace_because_tainted']);
    assert.deepEqual(entry.recreated_instances.sort(), ['0', '1']);
});

test('buildReducedPayload: ranks groups by destructive instance count (replace+delete) desc', () => {
    const plan = {
        resource_changes: [
            // calm module: 10 create, 3 update, 0 destructive
            ...Array.from({ length: 10 }, (_, i) => resource({ address: `module.calm.aws_x.c${i}`, module_address: 'module.calm', type: 'aws_x', name: `c${i}`, change: { actions: ['create'] } })),
            ...Array.from({ length: 3 }, (_, i) => resource({ address: `module.calm.aws_y.u${i}`, module_address: 'module.calm', type: 'aws_y', name: `u${i}`, change: { actions: ['update'], before: { a: i }, after: { a: i + 1 } } })),
            // risky module: 5 replace
            ...Array.from({ length: 5 }, (_, i) => resource({ address: `module.risky.aws_z.x${i}`, module_address: 'module.risky', type: 'aws_z', name: `x${i}`, change: { actions: ['delete', 'create'] } })),
        ],
    };
    const { payload } = buildReducedPayload(plan, []);
    assert.equal(payload.modules[0].module, 'module.risky');
    assert.equal(payload.modules[1].module, 'module.calm');
});

test('buildReducedPayload: significant_total counts instances, modules_total counts groups', () => {
    const plan = {
        resource_changes: [
            resource({ address: 'aws_instance.web[0]', type: 'aws_instance', name: 'web', index: 0, change: { actions: ['create'] } }),
            resource({ address: 'aws_instance.web[1]', type: 'aws_instance', name: 'web', index: 1, change: { actions: ['create'] } }),
            resource({ address: 'aws_s3_bucket.b', type: 'aws_s3_bucket', name: 'b', change: { actions: ['create'] } }),
            resource({ change: { actions: ['no-op'] } }),
        ],
    };
    const { payload } = buildReducedPayload(plan, []);
    // 3 instances across 2 groups (the web for_each + the bucket).
    assert.equal(payload.change_summary.significant_total, 3);
    assert.equal(payload.change_summary.modules_total, 2);
    assert.equal(payload.change_summary.total_changes, 3);
});

test('buildReducedPayload: only cosmetic changes → significantCount 0 (client skips backend)', () => {
    const plan = {
        resource_changes: [
            resource({ change: { actions: ['update'], before: { tags: { A: '1' } }, after: { tags: { A: '2' } } } }),
            resource({ change: { actions: ['no-op'] } }),
        ],
    };
    const { significantCount } = buildReducedPayload(plan, []);
    assert.equal(significantCount, 0);
});

test('buildReducedPayload: collapsed for_each updates union their changed attributes', () => {
    const plan = {
        resource_changes: [
            resource({ address: 'azurerm_static_web_app.sites["a"]', type: 'azurerm_static_web_app', name: 'sites', index: 'a', change: { actions: ['update'], before: { app_settings: 1 }, after: { app_settings: 2 } } }),
            resource({ address: 'azurerm_static_web_app.sites["b"]', type: 'azurerm_static_web_app', name: 'sites', index: 'b', change: { actions: ['update'], before: { sku: 'Free' }, after: { sku: 'Std' } } }),
        ],
    };
    const { payload } = buildReducedPayload(plan, []);
    assert.deepEqual(payload.modules[0].resources[0].changed, ['app_settings', 'sku']);
});

test('overviewLine: sums action breakdowns across groups (instance counts)', () => {
    const modules = [
        { module: 'a', action_breakdown: { replace: 0, delete: 1, create: 0, update: 2 } },
        { module: 'b', action_breakdown: { replace: 1, delete: 1, create: 3, update: 1 } },
    ];
    assert.equal(overviewLine(modules), '3 created · 1 recreated · 2 destroyed · 3 updated');
});

test('overviewLine: renders action tally and empty when nothing', () => {
    assert.equal(overviewLine([{ module: 'a', action_breakdown: { replace: 0, delete: 0, create: 1, update: 0 } }]), '1 created');
    assert.equal(overviewLine([]), '');
    assert.equal(overviewLine(undefined), '');
});

test('groupKey / blockAddress: module vs root, ignoring for_each index', () => {
    assert.equal(blockAddress({ module_address: 'module.cosmos', type: 'azurerm_cosmosdb_account', name: 'this', address: 'module.cosmos.azurerm_cosmosdb_account.this' }), 'module.cosmos.azurerm_cosmosdb_account.this');
    assert.equal(blockAddress({ type: 'azurerm_static_web_app', name: 'sites', address: 'azurerm_static_web_app.sites["a"]' }), 'azurerm_static_web_app.sites');
    assert.equal(groupKey({ module_address: 'module.cosmos', type: 't', name: 'n', address: 'module.cosmos.t.n' }), 'module.cosmos');
    assert.equal(groupKey({ type: 'azurerm_static_web_app', name: 'sites', address: 'azurerm_static_web_app.sites["a"]' }), 'azurerm_static_web_app.sites');
});

test('changedAttributes: detects diffs and after_unknown (names only, sorted)', () => {
    const change = {
        before: { instance_type: 't2.micro', name: 'x' },
        after: { instance_type: 't3.micro', name: 'x' },
        after_unknown: { arn: true },
    };
    assert.deepEqual(changedAttributes(change), ['arn', 'instance_type']);
});

test('changedTagKeys: detects added/removed/changed keys incl. after_unknown', () => {
    const change = {
        before: { tags: { A: '1', B: '2' } },
        after: { tags: { A: '9', C: '3' } },
        after_unknown: { tags: { D: true } },
    };
    const keys = changedTagKeys(change).sort();
    assert.deepEqual(keys, ['A', 'B', 'C', 'D']);
});

test('buildCapacityNotice: renders both group-capacity and cosmetic parts (resource counts)', () => {
    const notice = buildCapacityNotice({
        modules_analyzed: 10,
        modules_omitted: 3,
        resources_omitted: 24,
        cosmetic_omitted: 5,
    });
    assert.match(notice, /3 additional change group\(s\) \(24 resource\(s\)\)/);
    assert.match(notice, /10 highest-impact groups/);
    assert.match(notice, /5 cosmetic tag-only/);
});

test('buildCapacityNotice: null when nothing omitted', () => {
    assert.equal(buildCapacityNotice({ modules_analyzed: 4, modules_omitted: 0, resources_omitted: 0, cosmetic_omitted: 0 }), null);
    assert.equal(buildCapacityNotice(null), null);
});

test('enrichModules: a standalone multi-instance block → code + meta header (no subitems)', () => {
    const analysis = { modules: [{ module: 'root.swa', business_impact: 'x', risk: 'y' }] };
    const payloadModules = [{
        module: 'root.swa',
        is_module: false,
        action_breakdown: { replace: 0, delete: 1, create: 0, update: 2 },
        resources: [{ address: 'azurerm_static_web_app.sites', instances: 3, action_breakdown: { replace: 0, delete: 1, create: 0, update: 2 }, destroyed_instances: ['legacy'] }],
    }];
    const [mod] = enrichModules(analysis, payloadModules);
    assert.equal(mod.code, 'azurerm_static_web_app.sites');
    assert.equal(mod.meta, '×3 — 1 destroyed, 2 updated (destroyed: legacy)');
    assert.deepEqual(mod.resources, []);
});

test('enrichModules: a single-instance block → action verb in meta', () => {
    const analysis = { modules: [{ module: 'aws_s3_bucket.logs', business_impact: 'x', risk: 'y' }] };
    const payloadModules = [{
        module: 'aws_s3_bucket.logs',
        is_module: false,
        action_breakdown: { replace: 0, delete: 0, create: 1, update: 0 },
        resources: [{ address: 'aws_s3_bucket.logs', instances: 1, action_breakdown: { replace: 0, delete: 0, create: 1, update: 0 } }],
    }];
    const [mod] = enrichModules(analysis, payloadModules);
    assert.equal(mod.code, 'aws_s3_bucket.logs');
    assert.equal(mod.meta, '(created)');
});

test('enrichModules: a single-instance update names the changed attributes in meta', () => {
    const analysis = { modules: [{ module: 'aws_iam_role.app', business_impact: 'x', risk: 'y' }] };
    const payloadModules = [{
        module: 'aws_iam_role.app',
        is_module: false,
        action_breakdown: { replace: 0, delete: 0, create: 0, update: 1 },
        resources: [{ address: 'aws_iam_role.app', instances: 1, action_breakdown: { replace: 0, delete: 0, create: 0, update: 1 }, changed: ['assume_role_policy', 'managed_policy_arns'] }],
    }];
    const [mod] = enrichModules(analysis, payloadModules);
    assert.equal(mod.meta, '(updated: assume_role_policy, managed_policy_arns)');
});

test('enrichModules: caps the changed list at 3 attributes with an ellipsis', () => {
    const analysis = { modules: [{ module: 'aws_x.y', business_impact: 'x', risk: 'y' }] };
    const payloadModules = [{
        module: 'aws_x.y',
        is_module: false,
        action_breakdown: { replace: 0, delete: 0, create: 0, update: 1 },
        resources: [{ address: 'aws_x.y', instances: 1, action_breakdown: { replace: 0, delete: 0, create: 0, update: 1 }, changed: ['a', 'b', 'c', 'd'] }],
    }];
    const [mod] = enrichModules(analysis, payloadModules);
    assert.equal(mod.meta, '(updated: a, b, c, …)');
});

test('enrichModules: a module → friendly code (no "module.") + per-resource code/meta subitems', () => {
    const analysis = { modules: [{ module: 'module.cosmos_db', business_impact: 'x', risk: 'y' }] };
    const payloadModules = [{
        module: 'module.cosmos_db',
        is_module: true,
        action_breakdown: { replace: 0, delete: 0, create: 2, update: 0 },
        resources: [
            { address: 'module.cosmos_db.azurerm_cosmosdb_account.this', instances: 1, action_breakdown: { replace: 0, delete: 0, create: 1, update: 0 } },
            { address: 'module.cosmos_db.azurerm_private_endpoint.pe', instances: 1, action_breakdown: { replace: 0, delete: 0, create: 1, update: 0 } },
        ],
    }];
    const [mod] = enrichModules(analysis, payloadModules);
    assert.equal(mod.code, 'cosmos_db');
    assert.equal(mod.meta, '— 2 created');
    assert.deepEqual(mod.resources, [
        { code: 'module.cosmos_db.azurerm_cosmosdb_account.this', meta: '(created)' },
        { code: 'module.cosmos_db.azurerm_private_endpoint.pe', meta: '(created)' },
    ]);
});

test('enrichModules: caps per-module rendered resources with a +N more marker', () => {
    const analysis = { modules: [{ module: 'module.big', business_impact: 'x', risk: 'y' }] };
    const payloadModules = [{
        module: 'module.big',
        is_module: true,
        action_breakdown: { replace: 0, delete: 0, create: 50, import: 0, update: 0 },
        resources: Array.from({ length: 50 }, (_, i) => ({ address: `module.big.aws_thing.n${i}`, instances: 1, action_breakdown: { replace: 0, delete: 0, create: 1, import: 0, update: 0 } })),
    }];
    const [mod] = enrichModules(analysis, payloadModules);
    assert.equal(mod.resources.length, 31);
    assert.deepEqual(mod.resources[30], { code: '+20 more', meta: 'resource(s) not shown' });
});

test('enrichModules: total rendered resources are capped across modules (Jira-safe budget)', () => {
    const mods = Array.from({ length: 8 }, (_, mi) => ({ module: `module.m${mi}`, business_impact: 'x', risk: 'y' }));
    const payloadModules = mods.map((m, mi) => ({
        module: m.module,
        is_module: true,
        action_breakdown: { replace: 0, delete: 0, create: 0, import: 0, update: 30 },
        resources: Array.from({ length: 30 }, (_, i) => ({ address: `module.m${mi}.aws_thing.n${i}`, instances: 1, action_breakdown: { replace: 0, delete: 0, create: 0, import: 0, update: 1 } })),
    }));
    const enriched = enrichModules({ modules: mods }, payloadModules);
    const totalShown = enriched.reduce((n, e) => n + e.resources.filter((r) => !String(r.code).startsWith('+')).length, 0);
    assert.ok(totalShown <= 150, `total shown ${totalShown} should be <= 150`);
    const minReal = Math.min(...enriched.map((e) => e.resources.filter((r) => !String(r.code).startsWith('+')).length));
    assert.ok(minReal >= 1, `every module should show some detail (min was ${minReal})`);
});

test('DLP guard: serialized grouped/collapsed payload never contains before/after values', () => {
    const plan = {
        format_version: '1.2',
        terraform_version: '1.9.0',
        resource_changes: [
            resource({
                address: 'module.db.aws_db_instance.main', module_address: 'module.db', type: 'aws_db_instance', name: 'main',
                change: {
                    actions: ['delete', 'create'],
                    before: { password: 'LEAK_BEFORE_SUPER_SECRET_123' },
                    after: { password: 'LEAK_AFTER_SUPER_SECRET_456' },
                    before_sensitive: { password: true },
                    after_sensitive: { password: true },
                },
            }),
            resource({
                address: 'aws_s3_bucket.a', type: 'aws_s3_bucket', name: 'a',
                change: {
                    actions: ['update'],
                    before: { tags: { Owner: 'LEAK_TAG_VALUE_alice' } },
                    after: { tags: { Owner: 'LEAK_TAG_VALUE_bob' } },
                },
            }),
        ],
    };
    const { payload } = buildReducedPayload(plan, ['Owner']);
    assert.doesNotMatch(JSON.stringify(payload), /LEAK_/);
});

// Mirrors the exact dummy plan in .github/workflows/e2e.yml so the E2E scenario is
// validated deterministically (module grouping + for_each collapse + notice + DLP)
// without running the workflow. Keep in sync if the E2E plan changes.
const E2E_PLAN = {
    format_version: '1.2',
    terraform_version: '1.9.0',
    resource_changes: [
        { address: 'module.cosmos_db.azurerm_cosmosdb_account.this', module_address: 'module.cosmos_db', type: 'azurerm_cosmosdb_account', name: 'this', change: { actions: ['create'] } },
        { address: 'module.cosmos_db.azurerm_private_endpoint.pe', module_address: 'module.cosmos_db', type: 'azurerm_private_endpoint', name: 'pe', change: { actions: ['create'] } },
        { address: 'aws_s3_bucket.logs', type: 'aws_s3_bucket', name: 'logs', change: { actions: ['create'] } },
        { address: 'aws_iam_role.app', type: 'aws_iam_role', name: 'app', change: { actions: ['update'], before: { assume_role_policy: 'LEAK_policy_old', max_session_duration: 3600 }, after: { assume_role_policy: 'LEAK_policy_new', max_session_duration: 7200 } } },
        { address: 'aws_instance.legacy', type: 'aws_instance', name: 'legacy', change: { actions: ['delete'] } },
        {
            address: 'aws_db_instance.main', type: 'aws_db_instance', name: 'main',
            change: {
                actions: ['delete', 'create'],
                before: { password: 'LEAK_BEFORE_SUPER_SECRET_123' },
                after: { password: 'LEAK_AFTER_SUPER_SECRET_456' },
                before_sensitive: { password: true },
                after_sensitive: { password: true },
            },
        },
        { address: 'data.aws_secretsmanager_secret.existing', type: 'aws_secretsmanager_secret', name: 'existing', change: { actions: ['read'] } },
        { address: 'aws_vpc.main', type: 'aws_vpc', name: 'main', change: { actions: ['no-op'] } },
        {
            address: 'aws_s3_bucket.assets', type: 'aws_s3_bucket', name: 'assets',
            change: { actions: ['update'], before: { tags: { Owner: 'LEAK_TAG_alice', Team: 'LEAK_TAG_platform' } }, after: { tags: { Owner: 'LEAK_TAG_bob', Team: 'LEAK_TAG_platform' } } },
        },
        {
            address: 'aws_sns_topic.alerts', type: 'aws_sns_topic', name: 'alerts',
            change: { actions: ['update'], before: { tags_all: { Team: 'LEAK_TAG_ops' } }, after: { tags_all: { Team: 'LEAK_TAG_sre' } } },
        },
        {
            address: 'aws_lambda_function.api', type: 'aws_lambda_function', name: 'api',
            change: { actions: ['update'], before: { tags: { Environment: 'LEAK_TAG_dev', Owner: 'LEAK_TAG_alice' } }, after: { tags: { Environment: 'LEAK_TAG_prod', Owner: 'LEAK_TAG_alice' } } },
        },
        { address: 'azurerm_static_web_app.sites["marketing"]', type: 'azurerm_static_web_app', name: 'sites', index: 'marketing', change: { actions: ['update'], before: { app_settings: { API_URL: 'LEAK_marketing_old' } }, after: { app_settings: { API_URL: 'LEAK_marketing_new' } } } },
        { address: 'azurerm_static_web_app.sites["docs"]', type: 'azurerm_static_web_app', name: 'sites', index: 'docs', change: { actions: ['update'], before: { app_settings: { API_URL: 'LEAK_docs_old' } }, after: { app_settings: { API_URL: 'LEAK_docs_new' } } } },
        { address: 'azurerm_static_web_app.sites["legacy"]', type: 'azurerm_static_web_app', name: 'sites', index: 'legacy', change: { actions: ['delete'] } },
        { address: 'aws_ecr_repository.adopted', type: 'aws_ecr_repository', name: 'adopted', change: { actions: ['no-op'], importing: { id: 'LEAK_IMPORT_ID_arn_ecr_adopted' } } },
    ],
};

test('E2E scenario: 11 significant instances across 8 groups, 2 cosmetic, read/no-op dropped', () => {
    const { payload, significantCount, cosmeticCount, moduleCount, totalCount } = buildReducedPayload(E2E_PLAN, ['Environment', 'CostCenter']);
    assert.equal(significantCount, 11);
    assert.equal(cosmeticCount, 2);
    assert.equal(moduleCount, 8);
    assert.equal(totalCount, 15);

    // cosmos_db is a real module with 2 resources.
    const cosmos = moduleByName(payload, 'module.cosmos_db');
    assert.equal(cosmos.is_module, true);
    assert.equal(cosmos.resources.length, 2);

    // The 3 static web apps collapse into one block with the lone delete preserved.
    const swa = moduleByName(payload, 'azurerm_static_web_app.sites');
    assert.equal(swa.resources[0].instances, 3);
    assert.deepEqual(swa.resources[0].action_breakdown, { replace: 0, delete: 1, create: 0, import: 0, update: 2 });
    assert.deepEqual(swa.resources[0].destroyed_instances, ['legacy']);
    // The bulk update's changed attributes are unioned across the updated instances.
    assert.deepEqual(swa.resources[0].changed, ['app_settings']);
    const iam = moduleByName(payload, 'aws_iam_role.app');
    assert.deepEqual(iam.resources[0].changed, ['assume_role_policy', 'max_session_duration']);

    // The relevant tag promoted the lambda to significant.
    const lambda = moduleByName(payload, 'aws_lambda_function.api');
    assert.deepEqual(lambda.resources[0].changed, ['tags.Environment']);

    // The no-op import is surfaced (not dropped) as an import action.
    const imported = moduleByName(payload, 'aws_ecr_repository.adopted');
    assert.deepEqual(imported.resources[0].action_breakdown, { replace: 0, delete: 0, create: 0, import: 1, update: 0 });

    assert.deepEqual(payload.change_summary, {
        total_changes: 13,
        cosmetic_omitted: 2,
        significant_total: 11,
        modules_total: 8,
    });
});

test('E2E scenario: DLP holds on the full plan (no LEAK_ values leak)', () => {
    const { payload } = buildReducedPayload(E2E_PLAN, ['Environment', 'CostCenter']);
    assert.doesNotMatch(JSON.stringify(payload), /LEAK_/);
});

// --- Additional plan-shape scenarios ---------------------------------------

test('buildReducedPayload: replace detected regardless of action order (create_before_destroy)', () => {
    const plan = {
        resource_changes: [
            { address: 'aws_db_instance.main', type: 'aws_db_instance', name: 'main', change: { actions: ['create', 'delete'] } },
        ]
    };
    const { payload, significantCount } = buildReducedPayload(plan, []);
    assert.equal(significantCount, 1);
    assert.deepEqual(payload.modules[0].resources[0].action_breakdown, { replace: 1, delete: 0, create: 0, import: 0, update: 0 });
});

test('buildReducedPayload: action_reason is captured and forwarded', () => {
    const plan = {
        resource_changes: [
            { address: 'aws_instance.web', type: 'aws_instance', name: 'web', action_reason: 'replace_because_tainted', change: { actions: ['delete', 'create'] } },
        ]
    };
    const { payload } = buildReducedPayload(plan, []);
    assert.deepEqual(payload.modules[0].resources[0].action_reason, ['replace_because_tainted']);
});

test('buildReducedPayload: empty plan yields nothing significant (client skips backend)', () => {
    const { significantCount, cosmeticCount, payload } = buildReducedPayload({ resource_changes: [] }, []);
    assert.equal(significantCount, 0);
    assert.equal(cosmeticCount, 0);
    assert.equal(payload.modules.length, 0);
});

test('buildReducedPayload: whole-module deletion groups all its resources as deletes', () => {
    const plan = {
        resource_changes: [
            { address: 'module.legacy.aws_instance.a', module_address: 'module.legacy', type: 'aws_instance', name: 'a', change: { actions: ['delete'] } },
            { address: 'module.legacy.aws_ebs_volume.b', module_address: 'module.legacy', type: 'aws_ebs_volume', name: 'b', change: { actions: ['delete'] } },
        ]
    };
    const { payload, moduleCount } = buildReducedPayload(plan, []);
    assert.equal(moduleCount, 1);
    assert.equal(payload.modules[0].module, 'module.legacy');
    assert.deepEqual(payload.modules[0].action_breakdown, { replace: 0, delete: 2, create: 0, import: 0, update: 0 });
    assert.equal(payload.modules[0].resources.length, 2);
});

test('buildReducedPayload: a large plan (500 distinct blocks) sends all and stays under the 512KB byte guard', () => {
    const changes = [];
    for (let i = 0; i < 500; i += 1) {
        changes.push({ address: `aws_instance.node_${i}`, type: 'aws_instance', name: `node_${i}`, change: { actions: ['update'], before: { ami: 'a' }, after: { ami: 'b' } } });
    }
    const { payload, significantCount, moduleCount } = buildReducedPayload({ format_version: '1.2', terraform_version: '1.9.0', resource_changes: changes }, []);
    assert.equal(significantCount, 500);
    assert.equal(moduleCount, 500);
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    assert.ok(bytes < 512 * 1024, `payload is ${bytes} bytes, expected < 524288`);
});

// --- Import handling --------------------------------------------------------

test('buildReducedPayload: an import (no-op + change.importing) is surfaced, not dropped, and DLP-safe', () => {
    const plan = {
        resource_changes: [
            { address: 'aws_s3_bucket.adopted', type: 'aws_s3_bucket', name: 'adopted', change: { actions: ['no-op'], importing: { id: 'LEAK_bucket_arn' } } },
        ]
    };
    const { payload, significantCount } = buildReducedPayload(plan, []);
    assert.equal(significantCount, 1);
    assert.deepEqual(payload.modules[0].resources[0].action_breakdown, { replace: 0, delete: 0, create: 0, import: 1, update: 0 });
    assert.doesNotMatch(JSON.stringify(payload), /LEAK_/);
});

test('buildReducedPayload: import groups rank below create and above update', () => {
    const plan = {
        resource_changes: [
            { address: 'aws_x.upd', type: 'aws_x', name: 'upd', change: { actions: ['update'], before: { a: 1 }, after: { a: 2 } } },
            { address: 'aws_y.imp', type: 'aws_y', name: 'imp', change: { actions: ['no-op'], importing: { id: 'i' } } },
            { address: 'aws_z.cre', type: 'aws_z', name: 'cre', change: { actions: ['create'] } },
        ]
    };
    const { payload } = buildReducedPayload(plan, []);
    assert.deepEqual(payload.modules.map((m) => m.module), ['aws_z.cre', 'aws_y.imp', 'aws_x.upd']);
});

test('overviewLine: imported ranks between created and updated', () => {
    const modules = [{ module: 'a', action_breakdown: { replace: 0, delete: 0, create: 1, import: 2, update: 3 } }];
    assert.equal(overviewLine(modules), '1 created \u00b7 2 imported \u00b7 3 updated');
});

test('enrichModules: a single import block → (imported) meta', () => {
    const analysis = { modules: [{ module: 'aws_s3_bucket.adopted', business_impact: 'x', risk: 'y' }] };
    const payloadModules = [{
        module: 'aws_s3_bucket.adopted',
        is_module: false,
        action_breakdown: { replace: 0, delete: 0, create: 0, import: 1, update: 0 },
        resources: [{ address: 'aws_s3_bucket.adopted', instances: 1, action_breakdown: { replace: 0, delete: 0, create: 0, import: 1, update: 0 } }],
    }];
    const [mod] = enrichModules(analysis, payloadModules);
    assert.equal(mod.meta, '(imported)');
});
