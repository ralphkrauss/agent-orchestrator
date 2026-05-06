import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RpcMethodSchema } from '../contract.js';
import { tools } from '../mcpTools.js';

type ObjectSchema = {
  type?: string;
  properties: Record<string, unknown>;
  required?: readonly string[];
};

const unsupportedTopLevelSchemaKeys = ['oneOf', 'anyOf', 'allOf', 'enum', 'not'] as const;

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
    // Issue #31 / T9 (OD2=B): start_run advertises codex_network for direct-mode overrides.
    assert.equal(Object.hasOwn(start.properties, 'codex_network'), true);
    assert.deepStrictEqual(
      (start.properties.codex_network as { enum: string[] }).enum,
      ['isolated', 'workspace', 'user-config'],
    );
    assert.equal(Object.hasOwn(start.properties, 'idle_timeout_seconds'), true);
    assert.equal(Object.hasOwn(start.properties, 'execution_timeout_seconds'), true);
    assert.deepStrictEqual(start.required, ['prompt', 'cwd']);

    const profiles = schemaFor('list_worker_profiles');
    assert.equal(Object.hasOwn(profiles.properties, 'profiles_file'), true);

    const upsertProfile = schemaFor('upsert_worker_profile');
    assert.deepStrictEqual(upsertProfile.required, ['profile', 'backend']);
    assert.equal(Object.hasOwn(upsertProfile.properties, 'profiles_file'), true);
    assert.equal(Object.hasOwn(upsertProfile.properties, 'cwd'), true);
    assert.equal(Object.hasOwn(upsertProfile.properties, 'model'), true);
    assert.equal(Object.hasOwn(upsertProfile.properties, 'reasoning_effort'), true);
    assert.equal(Object.hasOwn(upsertProfile.properties, 'service_tier'), true);
    // Issue #31 / T4: codex_network is round-tripped through upsert_worker_profile.
    assert.equal(Object.hasOwn(upsertProfile.properties, 'codex_network'), true);
    assert.deepStrictEqual(
      (upsertProfile.properties.codex_network as { enum: string[] }).enum,
      ['isolated', 'workspace', 'user-config'],
    );
    assert.equal(Object.hasOwn(upsertProfile.properties, 'create_if_missing'), true);

    const followup = schemaFor('send_followup');
    assert.equal(Object.hasOwn(followup.properties, 'metadata'), true);
    assert.equal(Object.hasOwn(followup.properties, 'reasoning_effort'), true);
    assert.equal(Object.hasOwn(followup.properties, 'service_tier'), true);
    // Issue #31 / T9 (OD2=B): send_followup advertises codex_network for direct-mode overrides.
    assert.equal(Object.hasOwn(followup.properties, 'codex_network'), true);
    assert.deepStrictEqual(
      (followup.properties.codex_network as { enum: string[] }).enum,
      ['isolated', 'workspace', 'user-config'],
    );
    assert.equal(Object.hasOwn(followup.properties, 'idle_timeout_seconds'), true);
    assert.equal(Object.hasOwn(followup.properties, 'execution_timeout_seconds'), true);
    assert.deepStrictEqual(followup.required, ['run_id', 'prompt']);

    const observability = schemaFor('get_observability_snapshot');
    assert.equal(Object.hasOwn(observability.properties, 'include_prompts'), true);
    assert.equal(Object.hasOwn(observability.properties, 'recent_event_limit'), true);
    assert.equal(Object.hasOwn(observability.properties, 'diagnostics'), true);

    const progress = schemaFor('get_run_progress');
    assert.equal(Object.hasOwn(progress.properties, 'after_sequence'), true);
    assert.equal(Object.hasOwn(progress.properties, 'limit'), true);
    assert.equal(Object.hasOwn(progress.properties, 'max_text_chars'), true);
    assert.deepStrictEqual(progress.required, ['run_id']);
  });

  it('advertises cursor as a direct backend in the start_run schema', () => {
    const start = schemaFor('start_run');
    const backend = start.properties.backend as { enum: string[] };
    assert.deepStrictEqual([...backend.enum].sort(), ['claude', 'codex', 'cursor']);
  });

  it('keeps advertised input schemas compatible with OpenCode tool loading', () => {
    for (const tool of tools) {
      const schema = schemaFor(tool.name);
      assert.equal(schema.type, 'object', `${tool.name} input schema must be an object`);
      for (const key of unsupportedTopLevelSchemaKeys) {
        assert.equal(Object.hasOwn(schema, key), false, `${tool.name} input schema has unsupported top-level ${key}`);
      }
    }
  });
});

function schemaFor(name: string): ObjectSchema {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.inputSchema as ObjectSchema;
}
