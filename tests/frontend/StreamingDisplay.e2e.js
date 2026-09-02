import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.describe('StreamingDisplay', () => {
    test.beforeEach(testSetup.awaitST);

    test('does not rebuild formatted DOM for unchanged streaming frames', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { StreamingDisplay } = await import('/scripts/streaming-display.js');
            const display = new StreamingDisplay().show();

            display.updateReasoning('**same reasoning**');
            display.updateContent('**same response**');

            const reasoningContent = document.querySelector('.streaming-display-reasoning-content');
            const textContent = document.querySelector('.streaming-display-text-content');
            const reasoningNode = reasoningContent?.firstElementChild;
            const textNode = textContent?.firstElementChild;

            display.updateReasoning('**same reasoning**');
            display.updateContent('**same response**');

            const unchanged = {
                reasoningNodeRetained: reasoningContent?.firstElementChild === reasoningNode,
                textNodeRetained: textContent?.firstElementChild === textNode,
            };

            display.updateReasoning('**updated reasoning**');
            display.updateContent('**updated response**');

            const updated = {
                reasoningChanged: reasoningContent?.textContent?.includes('updated reasoning'),
                textChanged: textContent?.textContent?.includes('updated response'),
            };

            display.hide({ instant: true });
            return { unchanged, updated };
        });

        expect(result.unchanged.reasoningNodeRetained).toBe(true);
        expect(result.unchanged.textNodeRetained).toBe(true);
        expect(result.updated.reasoningChanged).toBe(true);
        expect(result.updated.textChanged).toBe(true);
    });
});
