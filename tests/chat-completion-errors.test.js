import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import { event_types } from '../public/scripts/events.js';

const source = fs.readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
function extractFunction(name) {
    const match = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?^}`, 'm'));
    if (!match) throw new Error(`Missing function: ${name}`);
    return match[0].replace(/^export /, '');
}
const functions = ['getChatCompletionErrorMessage', 'tryParseStreamingError',
    'checkQuotaError', 'checkModerationError', 'sendOpenAIRequest'];

describe('chat completion streaming errors', () => {
    let context, response, toast, chunks, read;
    beforeEach(() => {
        chunks = [];
        toast = jest.fn();
        read = jest.fn(async () => chunks.length ? { done: false, value: { data: chunks.shift() } } : { done: true });
        response = { ok: true, status: 200, statusText: 'OK', body: { pipeThrough: jest.fn() } };
        context = vm.createContext({
            AbortController, JSON, String, Error,
            toastr: { error: toast, info: jest.fn() },
            t: (strings, ...values) => String.raw({ raw: strings }, ...values),
            oai_settings: {}, event_types,
            eventSource: { emit: jest.fn(async () => {}) },
            getChatCompletionModel: () => 'test',
            createGenerationParameters: async () => ({ generate_data: {}, stream: true, canMultiSwipe: true }),
            fetch: jest.fn(async () => response), getRequestHeaders: () => ({}),
            getEventSourceStream: () => ({ readable: { getReader: () => ({ read }) } }),
            getStreamingReply: (data, state) => {
                const delta = data.choices?.[0]?.delta ?? {};
                state.reasoning += delta.reasoning_content ?? '';
                state.images = data.images ?? state.images;
                return delta.content ?? '';
            },
            parseChatCompletionLogprobs: () => null,
            ToolManager: { parseToolCalls: (calls, data) => calls.push(...(data.choices?.[0]?.delta?.tool_calls ?? [])) },
        });
        vm.runInContext(functions.map(extractFunction).join('\n'), context);
    });

    test.each([
        [{ error: { message: 'upstream timed out' } }, 'upstream timed out'],
        [{ error: 'rate limited' }, 'rate limited'],
        [{ error: { code: 'overloaded' } }, 'overloaded'],
        [{ message: 'model unavailable' }, 'model unavailable'],
        [{ detail: 'gateway timeout' }, 'gateway timeout'],
        [{ detail: { error: { message: 'capacity exceeded' } } }, 'capacity exceeded'],
    ])('propagates a provider error without swallowing it: %j', (data, message) => {
        expect(() => context.tryParseStreamingError(response, JSON.stringify(data))).toThrow(message);
        expect(toast).toHaveBeenCalledWith(message, 'Chat Completion API');
        expect(toast).not.toHaveBeenCalledWith('OK', expect.anything());
    });

    test('quiet suppresses the toast but still propagates errors', () => {
        expect(() => context.tryParseStreamingError(response, '{"error":"failed"}', { quiet: true })).toThrow('failed');
        expect(toast).not.toHaveBeenCalled();
    });

    test('quota errors also escape the JSON parsing guard', () => {
        expect(() => context.tryParseStreamingError(response, '{"quota_error":true}', { quiet: true })).toThrow();
    });

    test.each(['[DONE]', ': keepalive', 'null', '{"choices":[]}', '{"message":""}',
        '{"type":"message_start","message":{"role":"assistant","content":[]}}',
    ])('ignores non-error data: %s', chunk => {
        expect(() => context.tryParseStreamingError(response, chunk)).not.toThrow();
        expect(toast).not.toHaveBeenCalled();
    });

    async function collect() {
        const generate = await context.sendOpenAIRequest('normal', []);
        const results = [];
        for await (const value of generate()) results.push(value);
        return results;
    }

    test.each(['eof', 'done', 'role only'])('reports an empty stream ending with %s', async kind => {
        if (kind === 'done') chunks.push('[DONE]');
        if (kind === 'role only') chunks.push('{"choices":[{"delta":{"role":"assistant"}}]}', '[DONE]');
        await expect(collect()).rejects.toThrow('The API returned an empty response.');
        expect(toast).toHaveBeenCalledTimes(1);
    });

    test('stops a stream at its first API error rather than consuming later chunks', async () => {
        chunks.push('{"error":{"message":"upstream timed out"}}', '[DONE]');
        await expect(collect()).rejects.toThrow('upstream timed out');
        expect(read).toHaveBeenCalledTimes(1);
        expect(toast).toHaveBeenCalledTimes(1);
    });

    test.each([
        { choices: [{ delta: { content: 'reply' } }] },
        { choices: [{ delta: { reasoning_content: 'reasoning' } }] },
        { choices: [{ delta: { tool_calls: [{ id: 'tool-1' }] } }] },
        { choices: [{ delta: {} }], images: ['image'] },
        { choices: [{ index: 1, delta: { content: 'alternate' } }] },
    ])('accepts streams containing text, reasoning, tool calls, images or alternate swipes: %j', async data => {
        chunks.push(JSON.stringify(data), '[DONE]');
        await expect(collect()).resolves.toHaveLength(1);
        expect(toast).not.toHaveBeenCalled();
    });
});
