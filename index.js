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

        core.info(
            `Found ${changedResources.length} changing resource(s) out of ${resourceChanges.length}.`
        );

        const payload = {
            format_version: plan.format_version,
            terraform_version: plan.terraform_version,
            resource_changes: changedResources,
        };

        // Expose the reduced plan for debugging (log + step output)
        core.info(`Reduced plan sent to backend:\n${JSON.stringify(payload, null, 2)}`);
        core.setOutput('reduced_plan', JSON.stringify(payload));

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

        // Expose the backend response for debugging (log + output + job summary)
        const result = response.result;
        core.info(`Backend response:\n${JSON.stringify(result, null, 2)}`);
        core.setOutput('response', JSON.stringify(result));

        await core.summary
            .addHeading('Terraform → Business Translator')
            .addCodeBlock(JSON.stringify(result, null, 2), 'json')
            .write();
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
