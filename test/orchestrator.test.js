const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildReducedPayload,
    changedAttributes,
    changedTagKeys,
    buildCapacityNotice,
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

test('buildReducedPayload: tag-only update is bundled as cosmetic, not sent', () => {
    const plan = {
        resource_changes: [
            resource({
                address: 'aws_s3_bucket.a',
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
    assert.equal(payload.resource_changes.length, 0);
    assert.equal(payload.change_summary.cosmetic_omitted, 1);
    assert.equal(payload.change_summary.significant_total, 0);
    assert.equal(payload.change_summary.total_changes, 1);
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
                address: 'aws_s3_bucket.a',
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
    assert.equal(payload.resource_changes.length, 1);
    assert.deepEqual(payload.resource_changes[0].changed, ['tags.Environment']);
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
    // Owner changed (not relevant); Environment did not change → stays cosmetic.
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
    assert.equal(payload.change_summary.total_changes, 0);
});

test('buildReducedPayload: sorts delete/replace > create > update', () => {
    const plan = {
        resource_changes: [
            resource({ address: 'u', change: { actions: ['update'], before: { size: 1 }, after: { size: 2 } } }),
            resource({ address: 'c', change: { actions: ['create'] } }),
            resource({ address: 'r', change: { actions: ['delete', 'create'] } }),
            resource({ address: 'd', change: { actions: ['delete'] } }),
        ],
    };
    const { payload } = buildReducedPayload(plan, []);
    const order = payload.resource_changes.map((r) => r.address);
    // delete + replace (rank 0) come first, then create (rank 1), then update (rank 2).
    assert.equal(order[order.length - 1], 'u');
    assert.ok(order.indexOf('c') < order.indexOf('u'));
    assert.ok(order.indexOf('d') < order.indexOf('c'));
    assert.ok(order.indexOf('r') < order.indexOf('c'));
});

test('buildReducedPayload: change_summary totals reconcile significant + cosmetic', () => {
    const plan = {
        resource_changes: [
            resource({ address: 'c', change: { actions: ['create'] } }),
            resource({
                address: 'tagonly',
                change: { actions: ['update'], before: { tags: { A: '1' } }, after: { tags: { A: '2' } } },
            }),
            resource({ change: { actions: ['no-op'] } }),
        ],
    };
    const { payload, significantCount, cosmeticCount } = buildReducedPayload(plan, []);
    assert.equal(significantCount, 1);
    assert.equal(cosmeticCount, 1);
    assert.equal(payload.change_summary.significant_total, 1);
    assert.equal(payload.change_summary.cosmetic_omitted, 1);
    assert.equal(payload.change_summary.total_changes, 2);
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

test('buildReducedPayload: carries action_reason and replace_triggered_by (names only)', () => {
    const plan = {
        resource_changes: [
            resource({
                address: 'aws_db_instance.main',
                action_reason: 'replace_because_cannot_update',
                change: {
                    actions: ['delete', 'create'],
                    replace_paths: [['engine_version'], ['identifier']],
                },
            }),
        ],
    };
    const { payload } = buildReducedPayload(plan, []);
    const entry = payload.resource_changes[0];
    assert.equal(entry.action_reason, 'replace_because_cannot_update');
    assert.deepEqual(entry.replace_triggered_by, ['engine_version', 'identifier']);
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

test('buildCapacityNotice: renders both capacity and cosmetic parts', () => {
    const notice = buildCapacityNotice({ analyzed: 10, cosmetic_omitted: 3, significant_omitted: 5 });
    assert.match(notice, /5 additional significant/);
    assert.match(notice, /10 highest-impact/);
    assert.match(notice, /3 cosmetic tag-only/);
});

test('buildCapacityNotice: null when nothing omitted', () => {
    assert.equal(buildCapacityNotice({ analyzed: 4, cosmetic_omitted: 0, significant_omitted: 0 }), null);
    assert.equal(buildCapacityNotice(null), null);
});

test('DLP guard: serialized payload never contains before/after values', () => {
    const plan = {
        format_version: '1.2',
        terraform_version: '1.9.0',
        resource_changes: [
            resource({
                address: 'aws_db_instance.main',
                change: {
                    actions: ['delete', 'create'],
                    before: { password: 'LEAK_BEFORE_SUPER_SECRET_123' },
                    after: { password: 'LEAK_AFTER_SUPER_SECRET_456' },
                    before_sensitive: { password: true },
                    after_sensitive: { password: true },
                },
            }),
            resource({
                address: 'aws_s3_bucket.a',
                change: {
                    actions: ['update'],
                    before: { tags: { Owner: 'LEAK_TAG_VALUE_alice' } },
                    after: { tags: { Owner: 'LEAK_TAG_VALUE_bob' } },
                },
            }),
        ],
    };
    const { payload } = buildReducedPayload(plan, ['Owner']);
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /LEAK_/);
});

// Mirrors the exact dummy plan in .github/workflows/e2e.yml so the E2E scenario is
// validated deterministically (right split + notice inputs + DLP) without running
// the workflow. Keep in sync if the E2E plan changes.
const E2E_PLAN = {
    format_version: '1.2',
    terraform_version: '1.9.0',
    resource_changes: [
        { address: 'aws_s3_bucket.logs', type: 'aws_s3_bucket', name: 'logs', change: { actions: ['create'] } },
        { address: 'aws_iam_role.app', type: 'aws_iam_role', name: 'app', change: { actions: ['update'] } },
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
    ],
};

test('E2E scenario: 5 significant (incl. relevant tag), 2 cosmetic, read/no-op dropped', () => {
    const { payload, significantCount, cosmeticCount, totalCount } = buildReducedPayload(E2E_PLAN, ['Environment', 'CostCenter']);
    assert.equal(significantCount, 5);
    assert.equal(cosmeticCount, 2);
    assert.equal(totalCount, 9);

    const addresses = payload.resource_changes.map((r) => r.address);
    assert.ok(addresses.includes('aws_lambda_function.api'));
    assert.ok(!addresses.includes('aws_s3_bucket.assets'));
    assert.ok(!addresses.includes('aws_sns_topic.alerts'));
    assert.ok(!addresses.includes('data.aws_secretsmanager_secret.existing'));
    assert.ok(!addresses.includes('aws_vpc.main'));

    const lambda = payload.resource_changes.find((r) => r.address === 'aws_lambda_function.api');
    assert.deepEqual(lambda.changed, ['tags.Environment']);

    assert.deepEqual(payload.change_summary, {
        total_changes: 7,
        cosmetic_omitted: 2,
        significant_total: 5,
    });

    // Destructive changes must survive first (delete/replace before create/update).
    assert.equal(actionRankIndex(addresses, 'aws_instance.legacy') < actionRankIndex(addresses, 'aws_s3_bucket.logs'), true);
});

test('E2E scenario: DLP holds on the full plan (no LEAK_ values leak)', () => {
    const { payload } = buildReducedPayload(E2E_PLAN, ['Environment', 'CostCenter']);
    assert.doesNotMatch(JSON.stringify(payload), /LEAK_/);
});

function actionRankIndex(addresses, address) {
    return addresses.indexOf(address);
}

