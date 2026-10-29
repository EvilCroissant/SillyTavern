import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import { event_types } from '../public/scripts/events.js';
import { SimpleMutex } from '../public/scripts/util/SimpleMutex.js';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const emitterSource = fs.readFileSync(new URL('../public/lib/eventemitter.js', import.meta.url), 'utf8');
// Run actual entry points without booting the UI. Their closing braces are
// unindented; nested functions' closing braces are indented.
function extractFunction(name) {
    const match = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?^}`, 'm'));
    if (!match) throw new Error(`Missing function: ${name}`);
    return match[0].replace(/^export /, '');
}
const functions = ['Generate', 'generateInternal', 'showStopButton', 'hideStopButton',
    'stopGeneration', 'unblockGeneration', 'activateSendButtons', 'deactivateSendButtons'];

describe('generation cancellation and cleanup', () => {
    let context, events, controls, ping, commands, hydrate;
    beforeEach(() => {
        controls = { stop: 'none', textarea: 'hello' };
        ping = jest.fn(async () => true);
        commands = jest.fn(async () => false);
        hydrate = jest.fn(async () => {});
        context = vm.createContext({
            AbortController, Date, String, Promise,
            console: { log: jest.fn(), debug: jest.fn(), error: jest.fn(), trace: jest.fn() },
            localStorage: { getItem: () => null }, event_types,
            abortController: new AbortController(),
            is_send_press: true, generation_started: null, streamingProcessor: null,
            document: { body: { dataset: { generating: 'true' } } },
            chat: [], chat_metadata: {}, this_chid: '0',
            main_api: 'openai', selected_group: null, online_status: 'no_connection',
            power_user: { instruct: { enabled: false } },
            setGenerationProgress: jest.fn(), unshallowCharacter: hydrate,
            processCommands: commands, isHordeGenerationNotAllowed: () => false,
            pingServer: ping, hideSwipeButtons: jest.fn(), showSwipeButtons: jest.fn(),
            flushEphemeralStoppingStrings: jest.fn(), flushWIInjections: jest.fn(),
            triggerAutoContinue: jest.fn(),
            t: (strings, ...values) => String.raw({ raw: strings }, ...values),
            toastr: { error: jest.fn() },
            $: selector => ({
                val: () => controls.textarea,
                css: value => {
                    if (value === 'display') return controls.stop;
                    if (selector === '#mes_stop') controls.stop = value.display;
                },
            }),
        });
        vm.runInContext(emitterSource.replace(/^export .*$/gm, '')
            + '\nvar eventSource = new EventEmitter();\n' + functions.map(extractFunction).join('\n'), context);
        events = context.eventSource;
    });

    test('cancellation after commands preserves input, skips server requests, and permits retry', async () => {
        let depth = 0;
        events.on(event_types.GENERATION_STARTED, () => { depth++; });
        events.on(event_types.GENERATION_ENDED, () => { depth--; });
        const cancel = () => context.stopGeneration();
        events.on(event_types.GENERATION_AFTER_COMMANDS, cancel);
        await context.Generate('normal');
        expect(ping).not.toHaveBeenCalled();
        expect(controls.textarea).toBe('hello');
        expect(depth).toBe(0);
        expect(context.is_send_press).toBe(false);
        events.removeListener(event_types.GENERATION_AFTER_COMMANDS, cancel);
        await context.Generate('normal');
        expect(ping).toHaveBeenCalledTimes(1);
        expect(depth).toBe(0);
    });

    test('cancellation in GENERATION_STARTED is preserved instead of resetting the controller', async () => {
        const ended = jest.fn();
        events.on(event_types.GENERATION_STARTED, () => context.stopGeneration());
        events.on(event_types.GENERATION_ENDED, ended);
        await context.Generate('normal');
        expect(context.abortController.signal.aborted).toBe(true);
        expect(commands).not.toHaveBeenCalled();
        expect(ping).not.toHaveBeenCalled();
        expect(ended).toHaveBeenCalledTimes(1);
        expect(context.is_send_press).toBe(false);
    });

    test('failed preparation releases the send mutex and UI so the next click works', async () => {
        commands.mockRejectedValueOnce(new Error('Command preparation failed'));
        const ended = jest.fn();
        events.on(event_types.GENERATION_ENDED, ended);
        const mutex = new SimpleMutex(() => context.Generate('normal'));
        await expect(mutex.update()).rejects.toThrow('Command preparation failed');
        expect(context.is_send_press).toBe(false);
        expect(context.document.body.dataset.generating).toBeUndefined();
        expect(mutex.isBusy).toBe(false);
        expect(ended).toHaveBeenCalledTimes(1);
        await mutex.update();
        expect(ping).toHaveBeenCalledTimes(1);
        expect(ended).toHaveBeenCalledTimes(2);
    });

    test('failed character loading releases UI without announcing an unstarted generation', async () => {
        hydrate.mockRejectedValueOnce(new Error('Character load failed'));
        const ended = jest.fn();
        events.on(event_types.GENERATION_ENDED, ended);
        await expect(context.Generate('normal')).rejects.toThrow('Character load failed');
        expect(context.is_send_press).toBe(false);
        expect(ended).not.toHaveBeenCalled();
    });

    test('stopping a visible generation announces completion exactly once', async () => {
        const ended = jest.fn();
        events.on(event_types.GENERATION_ENDED, ended);
        events.on(event_types.GENERATION_AFTER_COMMANDS, () => {
            context.deactivateSendButtons();
            context.stopGeneration();
            context.activateSendButtons();
        });
        await context.Generate('normal');
        expect(controls.stop).toBe('none');
        expect(ended).toHaveBeenCalledTimes(1);
    });

    test('server failure and a disconnected backend both finish the lifecycle', async () => {
        const ended = jest.fn();
        events.on(event_types.GENERATION_ENDED, ended);
        ping.mockResolvedValueOnce(false);
        await expect(context.Generate('normal')).rejects.toThrow('Server unreachable');
        expect(context.is_send_press).toBe(false);
        await context.Generate('normal');
        expect(ended).toHaveBeenCalledTimes(2);
    });

    test('reuses an external controller for a group member', async () => {
        const controller = new AbortController();
        context.abortController = controller;
        events.on(event_types.GENERATION_STARTED, () => controller.abort());
        await context.Generate('normal', { signal: controller.signal });
        expect(context.abortController).toBe(controller);
        expect(ping).not.toHaveBeenCalled();
    });

    test('button changes alone do not impersonate completed generations', () => {
        const ended = jest.fn();
        events.on(event_types.GENERATION_ENDED, ended);
        context.deactivateSendButtons();
        context.activateSendButtons();
        context.activateSendButtons();
        expect(ended).not.toHaveBeenCalled();
    });

    test('a quiet generation does not unlock a foreground stream', async () => {
        context.streamingProcessor = { isFinished: false };
        const ended = jest.fn();
        events.on(event_types.GENERATION_ENDED, ended);
        events.on(event_types.GENERATION_AFTER_COMMANDS, () => context.abortController.abort());
        await context.Generate('quiet');
        expect(context.is_send_press).toBe(true);
        expect(context.document.body.dataset.generating).toBe('true');
        expect(ended).not.toHaveBeenCalled();
    });

    test('auto-continue starts after cleanup and end notification without losing its busy state', async () => {
        const order = [];
        // Isolate successful completion of the wrapper. The earlier tests run
        // the real preparation code through its cancellation/error paths.
        vm.runInContext('generateInternal = async () => ({ messageChunk: "reply" });', context);
        events.on(event_types.GENERATION_ENDED, () => order.push('ended'));
        context.triggerAutoContinue = jest.fn(() => {
            expect(context.is_send_press).toBe(false);
            order.push('continue');
            context.is_send_press = true;
        });
        await context.Generate('normal');
        expect(order).toEqual(['ended', 'continue']);
        expect(context.is_send_press).toBe(true);
    });

    test('nested tool generations only trigger auto-continue from the outer call', async () => {
        vm.runInContext(`generateInternal = async (type, options) => options.depth
            ? { messageChunk: 'reply' } : Generate(type, { depth: 1 });`, context);
        const ended = jest.fn();
        events.on(event_types.GENERATION_ENDED, ended);
        await context.Generate('normal');
        expect(ended).toHaveBeenCalledTimes(2);
        expect(context.triggerAutoContinue).toHaveBeenCalledTimes(1);
    });

    test('dry runs do not clear foreground state or announce its end', async () => {
        vm.runInContext('generateInternal = async () => undefined;', context);
        const ended = jest.fn();
        events.on(event_types.GENERATION_ENDED, ended);
        await context.Generate('normal', {}, true);
        expect(context.is_send_press).toBe(true);
        expect(ended).not.toHaveBeenCalled();
    });
});
