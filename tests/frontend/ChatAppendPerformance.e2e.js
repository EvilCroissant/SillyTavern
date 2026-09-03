import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.describe('Chat append performance', () => {
    test.beforeEach(testSetup.awaitST);

    test('updates only affected swipe controls when appending to a long chat', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { newAssistantChat } = await import('./script.js');
            const context = window.SillyTavern.getContext();
            const chat = context.chat;

            await newAssistantChat({ temporary: true });
            chat.length = 0;
            document.querySelector('#chat').replaceChildren();

            const createMessage = (index) => ({
                name: index % 2 ? 'Assistant' : 'User',
                is_user: index % 2 === 0,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: `Historical message ${index}`,
                extra: {},
            });

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
