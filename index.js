const fs = require('fs');
const core = require('@actions/core');
const { HttpClient } = require('@actions/http-client');

async function run() {
    try {
        const planPath = core.getInput('plan_path', { required: true });
        const apiUrl = core.getInput('api_url', { required: false });
        const audience = core.getInput('audience', { required: false });

        core.info(`Reading Terraform plan from: ${planPath}`);
        if (!fs.existsSync(planPath)) {
            throw new Error(`Plan file not found at "${planPath}".`);
        }

        const rawPlan = fs.readFileSync(planPath, 'utf8');
        const plan = JSON.parse(rawPlan);

        const resourceChanges = Array.isArray(plan.resource_changes)
            ? plan.resource_changes
            : [];

        const changedResources = resourceChanges.filter((resource) => {
            const actions = resource.change && resource.change.actions;
            if (!Array.isArray(actions)) {
                return false;
            }
            return !(actions.length === 1 && actions[0] === 'no-op');
        });

        core.info(
            `Found ${changedResources.length} changing resource(s) out of ${resourceChanges.length}.`
        );

        const payload = {
            format_version: plan.format_version,
            terraform_version: plan.terraform_version,
            resource_changes: changedResources,
        };

        const idToken = await core.getIDToken(audience);

        const httpClient = new HttpClient('terraform2jira-action');
        const response = await httpClient.postJson(apiUrl, payload, {
            Authorization: `Bearer ${idToken}`,
        });

        const statusCode = response.statusCode;
        if (statusCode < 200 || statusCode >= 300) {
            throw new Error(
                `Backend responded with status ${statusCode}: ${JSON.stringify(response.result)}`
            );
        }

        core.info(`Plan summary sent successfully (status ${statusCode}).`);
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
