import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

async function prepareChat(page, { rules = [{}], count = 5, startIndex = 0, alternating = false } = {}) {
    await page.evaluate(async ({ rules, count, startIndex, alternating }) => {
        const { newAssistantChat, redisplayChat } = await import('./script.js');
        const { extension_settings } = await import('./scripts/extensions.js');
        const { chat } = window.SillyTavern.getContext();
        await newAssistantChat({ temporary: true });
        extension_settings.disabledExtensions = extension_settings.disabledExtensions.filter(name => name !== 'regex');
        extension_settings.regex = rules.map((rule, index) => ({
            id: `depth-test-${index}`,
            scriptName: `Depth test ${index}`,
            findRegex: '/.+/gs',
            replaceString: '',
            trimStrings: [],
            placement: [2],
            markdownOnly: true,
            promptOnly: false,
            disabled: false,
            minDepth: 5,
            maxDepth: null,
            substituteRegex: 0,
            ...rule,
        }));
        chat.length = 0;
        chat.push(...Array.from({ length: count }, (_, index) => ({
            name: 'Depth test',
            is_user: alternating && index % 2 === 0,
            is_system: false,
            send_date: new Date().toISOString(),
            mes: `Chapter ${index}`,
            extra: {},
        })));
        document.querySelector('#chat').replaceChildren();
        await redisplayChat({ startIndex, fade: false });
    }, { rules, count, startIndex, alternating });
}

async function appendMessage(page, overrides = {}) {
    await page.evaluate(async overrides => {
        const { addOneMessage } = await import('./script.js');
        const { chat } = window.SillyTavern.getContext();
        const message = {
            name: 'Depth test',
            is_user: false,
            is_system: false,
            send_date: new Date().toISOString(),
            mes: `Chapter ${chat.length}`,
            extra: {},
            ...overrides,
        };
        chat.push(message);
        addOneMessage(message, { scroll: false });
    }, overrides);
}

const textAt = (page, id) => page.locator(`#chat > .mes[mesid="${id}"] .mes_text`);

test.describe('Display regex depth updates', () => {
    test.beforeEach(testSetup.awaitST);

    test('hides at depth five and restores after deletion without reloading or rewriting history', async ({ page }) => {
        await prepareChat(page);
        await expect(textAt(page, 0)).toHaveText('Chapter 0');
        const unchangedNode = await textAt(page, 1).evaluateHandle(element => element.firstChild);

        await appendMessage(page);

        await expect(textAt(page, 0)).toBeEmpty();
        await expect(textAt(page, 1)).toHaveText('Chapter 1');
        expect(await textAt(page, 1).evaluate((element, node) => element.firstChild === node, unchangedNode)).toBe(true);
        expect(await page.evaluate(() => window.SillyTavern.getContext().chat[0].mes)).toBe('Chapter 0');

        await page.evaluate(async () => (await import('./script.js')).deleteLastMessage());

        await expect(textAt(page, 0)).toHaveText('Chapter 0');
    });

    test('updates both ends of a bounded depth range', async ({ page }) => {
        await prepareChat(page, { count: 3, rules: [{ minDepth: 1, maxDepth: 2 }] });
        await expect(textAt(page, 0)).toBeEmpty();
        await expect(textAt(page, 1)).toBeEmpty();
        await expect(textAt(page, 2)).toHaveText('Chapter 2');

        await appendMessage(page);

        await expect(textAt(page, 0)).toHaveText('Chapter 0');
        await expect(textAt(page, 1)).toBeEmpty();
        await expect(textAt(page, 2)).toBeEmpty();

        await page.evaluate(async () => (await import('./script.js')).deleteLastMessage());

        await expect(textAt(page, 0)).toBeEmpty();
        await expect(textAt(page, 2)).toHaveText('Chapter 2');
    });

    test('respects roles and ignores disabled and prompt-only rules', async ({ page }) => {
        await prepareChat(page, { alternating: true, rules: [
            {},
            { placement: [1], disabled: true },
            { placement: [1], markdownOnly: false, promptOnly: true },
        ] });
        const userNode = await textAt(page, 0).evaluateHandle(element => element.firstChild);

        await appendMessage(page);
        await appendMessage(page);

        await expect(textAt(page, 0)).toHaveText('Chapter 0');
        await expect(textAt(page, 1)).toBeEmpty();
        expect(await textAt(page, 0).evaluate((element, node) => element.firstChild === node, userNode)).toBe(true);
    });

    test('does not count system messages toward depth', async ({ page }) => {
        await prepareChat(page);
        await appendMessage(page, { is_system: true });
        await expect(textAt(page, 0)).toHaveText('Chapter 0');

        await appendMessage(page);

        await expect(textAt(page, 0)).toBeEmpty();
    });

    test('restores messages when deleting from the middle and renumbering the remaining floors', async ({ page }) => {
        await prepareChat(page, { count: 6 });
        await expect(textAt(page, 0)).toBeEmpty();

        await page.evaluate(async () => (await import('./script.js')).deleteMessage(3));

        await expect(textAt(page, 0)).toHaveText('Chapter 0');
        await expect(textAt(page, 3)).toHaveText('Chapter 4');
        await expect(page.locator('#chat > .mes')).toHaveCount(5);
    });

    test('updates loaded history without creating unloaded floors', async ({ page }) => {
        await prepareChat(page, { count: 12, startIndex: 7 });
        await expect(textAt(page, 7)).toHaveText('Chapter 7');

        await appendMessage(page);

        await expect(textAt(page, 7)).toBeEmpty();
        await expect(page.locator('#chat > .mes')).toHaveCount(6);
        await expect(page.locator('#chat > .mes[mesid="0"]')).toHaveCount(0);
    });

    test('restores all affected floors after a batch deletion', async ({ page }) => {
        await prepareChat(page, { count: 8 });
        await expect(textAt(page, 0)).toBeEmpty();
        await expect(textAt(page, 2)).toBeEmpty();

        await page.evaluate(async () => {
            const { chat, eventSource, event_types } = window.SillyTavern.getContext();
            chat.splice(5);
            for (const element of document.querySelectorAll('#chat > .mes')) {
                if (Number(element.getAttribute('mesid')) >= 5) element.remove();
            }
            await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
        });

        await expect(textAt(page, 0)).toHaveText('Chapter 0');
        await expect(textAt(page, 2)).toHaveText('Chapter 2');
    });
});
