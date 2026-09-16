import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.describe('Chat append performance', () => {
    test.beforeEach(testSetup.awaitST);

    test('renders long chat in batches without losing message order', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { newAssistantChat, redisplayChat } = await import('./script.js');
            const context = window.SillyTavern.getContext();
            const chat = context.chat;

            await newAssistantChat({ temporary: true });
            chat.length = 0;
            document.querySelector('#chat').replaceChildren();

            const messages = Array.from({ length: 78 }, (_, index) => ({
                name: index % 2 ? 'Assistant' : 'User',
                is_user: index % 2 === 0,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: `Historical message ${index}`,
                extra: {},
            }));
            chat.push(...messages);

            let yielded = false;
            const timer = setTimeout(() => {
                yielded = true;
            }, 0);

            const rendered = await redisplayChat({ targetChat: messages, fade: false });
            clearTimeout(timer);

            return {
                rendered,
                yielded,
                messageCount: document.querySelectorAll('#chat .mes').length,
                messageIds: [...document.querySelectorAll('#chat .mes')].map(element => Number(element.getAttribute('mesid'))),
                lastMesCount: document.querySelectorAll('#chat .mes.last_mes').length,
            };
        });

        expect(result.rendered).toBe(true);
        expect(result.yielded).toBe(true);
        expect(result.messageCount).toBe(78);
        expect(result.messageIds).toEqual(Array.from({ length: 78 }, (_, index) => index));
        expect(result.lastMesCount).toBe(1);
    });

    test('cancels an obsolete chat render when a newer render starts', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { newAssistantChat, redisplayChat } = await import('./script.js');
            const context = window.SillyTavern.getContext();
            const chat = context.chat;

            await newAssistantChat({ temporary: true });
            chat.length = 0;
            document.querySelector('#chat').replaceChildren();

            const firstChat = Array.from({ length: 32 }, (_, index) => ({
                name: 'First chat',
                is_user: index % 2 === 0,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: `First chat message ${index}`,
                extra: {},
            }));
            const secondChat = Array.from({ length: 5 }, (_, index) => ({
                name: 'Second chat',
                is_user: index % 2 === 0,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: `Second chat message ${index}`,
                extra: {},
            }));

            const firstRender = redisplayChat({ targetChat: firstChat, fade: false });
            await Promise.resolve();
            const secondRender = redisplayChat({ targetChat: secondChat, fade: false });
            const [firstResult, secondResult] = await Promise.all([firstRender, secondRender]);

            return {
                firstResult,
                secondResult,
                messageCount: document.querySelectorAll('#chat .mes').length,
                messageTexts: [...document.querySelectorAll('#chat .mes .mes_text')].map(element => element.textContent.trim()),
                lastMesCount: document.querySelectorAll('#chat .mes.last_mes').length,
            };
        });

        expect(result.firstResult).toBe(false);
        expect(result.secondResult).toBe(true);
        expect(result.messageCount).toBe(5);
        expect(result.messageTexts).toEqual(Array.from({ length: 5 }, (_, index) => `Second chat message ${index}`));
        expect(result.lastMesCount).toBe(1);
    });

    test('updates only affected swipe controls when appending to a long chat', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { newAssistantChat } = await import('./script.js');
            const context = window.SillyTavern.getContext();
            const chat = context.chat;
            const createMessage = (index) => ({
                name: index % 2 ? 'Assistant' : 'User',
                is_user: index % 2 === 0,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: `Historical message ${index}`,
                extra: {},
            });

            await newAssistantChat({ temporary: true });
            chat.length = 0;
            document.querySelector('#chat').replaceChildren();

            for (let index = 0; index < 250; index++) {
                const message = createMessage(index);
                chat.push(message);
                context.addOneMessage(message, { scroll: false });
            }

            let lastMesRemovals = 0;
            let swipeFadeToggles = 0;
            const originalRemoveClass = $.fn.removeClass;
            const originalToggle = DOMTokenList.prototype.toggle;

            $.fn.removeClass = function (...args) {
                if (args[0] === 'last_mes') {
                    lastMesRemovals += this.length;
                }
                return originalRemoveClass.apply(this, args);
            };
            DOMTokenList.prototype.toggle = function (token, ...args) {
                if (token === 'fade') {
                    swipeFadeToggles++;
                }
                return originalToggle.call(this, token, ...args);
            };

            const previousLastMessage = document.querySelector('#chat .mes.last_mes');
            const message = createMessage(250);
            chat.push(message);

            try {
                context.addOneMessage(message, { scroll: false });
            } finally {
                $.fn.removeClass = originalRemoveClass;
                DOMTokenList.prototype.toggle = originalToggle;
            }

            const currentLastMessage = document.querySelector('#chat .mes.last_mes');
            return {
                lastMesRemovals,
                swipeFadeToggles,
                previousLastWasCleared: !previousLastMessage.classList.contains('last_mes'),
                lastMessageId: Number(currentLastMessage?.getAttribute('mesid')),
                lastMesCount: document.querySelectorAll('#chat .mes.last_mes').length,
            };
        });

        expect(result.lastMesRemovals).toBeLessThanOrEqual(1);
        expect(result.swipeFadeToggles).toBeLessThanOrEqual(2);
        expect(result.previousLastWasCleared).toBe(true);
        expect(result.lastMessageId).toBe(250);
        expect(result.lastMesCount).toBe(1);
    });
});
