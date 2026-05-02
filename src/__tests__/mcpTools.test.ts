import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RpcMethodSchema } from '../contract.js';
import { tools } from '../mcpTools.js';

type ObjectSchema = {
  properties: Record<string, unknown>;
  required?: readonly string[];
  oneOf?: readonly unknown[];
};

describe('MCP tool registration', () => {
  it('registers every exposed tool as a known RPC method', () => {
    const rpcMethods = new Set<string>(RpcMethodSchema.options);
    for (const tool of tools) {
      assert.equal(rpcMethods.has(tool.name), true, `${tool.name} is not an RPC method`);
    }
  });

  it('exposes follow-up metadata and observability snapshot arguments', () => {
    const start = schemaFor('start_run');
    assert.equal(Object.hasOwn(start.properties, 'route'), false);
    assert.equal(Object.hasOwn(start.properties, 'profile'), true);
    assert.equal(Object.hasOwn(start.properties, 'profiles_file'), true);
    assert.equal(Object.hasOwn(start.properties, 'reasoning_effort'), true);
    assert.equal(Object.hasOwn(start.properties, 'service_tier'), true);
    assert.deepStrictEqual(start.required, ['prompt', 'cwd']);
    assert.deepStrictEqual(start.oneOf, [
      {
        required: ['backend'],
        not: { required: ['profile'] },
      },
      {
        required: ['profile'],
        not: {
          anyOf: [
            { required: ['backend'] },
            { required: ['model'] },
            { required: ['reasoning_effort'] },
            { required: ['service_tier'] },
          ],
        },
      },
    ]);

    const profiles = schemaFor('list_worker_profiles');
    assert.equal(Object.hasOwn(profiles.properties, 'profiles_file'), true);

    const followup = schemaFor('send_followup');
    assert.equal(Object.hasOwn(followup.properties, 'metadata'), true);
    assert.equal(Object.hasOwn(followup.properties, 'reasoning_effort'), true);
    assert.equal(Object.hasOwn(followup.properties, 'service_tier'), true);
    assert.deepStrictEqual(followup.required, ['run_id', 'prompt']);

    const observability = schemaFor('get_observability_snapshot');
    assert.equal(Object.hasOwn(observability.properties, 'include_prompts'), true);
    assert.equal(Object.hasOwn(observability.properties, 'recent_event_limit'), true);
    assert.equal(Object.hasOwn(observability.properties, 'diagnostics'), true);
  });
});

function schemaFor(name: string): ObjectSchema {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.inputSchema as ObjectSchema;
}
