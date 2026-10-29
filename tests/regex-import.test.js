import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import lodash from 'lodash';

const indexURL = new URL('../public/scripts/extensions/regex/index.js', import.meta.url).href;
const engineURL = new URL('../public/scripts/extensions/regex/engine.js', import.meta.url).href;
const managerURL = new URL('../public/scripts/preset-manager.js', import.meta.url).href;
const sources = new Map([indexURL, engineURL, managerURL].map(url => [url, fs.readFileSync(new URL(url), 'utf8')]));

// Link the real importer, regex storage engine and preset writer. Only their
// external browser/network dependencies are replaced, so per-rule saves regress
// the request-count assertions below.
const dependencyExports = new Map();
for (const [url, source] of sources) {
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)';/g)) {
        const dependencyURL = new URL(match[2], url).href;
        const names = dependencyExports.get(dependencyURL) ?? new Set();
        for (const name of match[1].split(',')) {
            names.add(name.trim().split(/\s+as\s+/)[0]);
        }
        dependencyExports.set(dependencyURL, names);
    }
}

function rule(name, overrides = {}) {
    return { id: 'exported-id', scriptName: name, findRegex: '/test/g', replaceString: name, placement: [1], ...overrides };
}

describe('batch regex file import', () => {
    let importFiles, context, fetch, refresh, success, error, saveSettingsDebounced, readFile;
    let settings, preset, characters, extensionSettings, writeExtensionField;

    beforeEach(async () => {
        const existing = rule('Existing', { id: 'existing-id' });
        settings = { extensions: { regex_scripts: [existing] } };
        preset = { extensions: { regex_scripts: [existing] } };
        characters = [{ avatar: 'character.png', data: { extensions: { regex_scripts: [existing] } } }];
        extensionSettings = { regex: [existing] };
        refresh = jest.fn(async () => {});
        success = jest.fn();
        error = jest.fn();
        saveSettingsDebounced = jest.fn();
        readFile = jest.fn(async file => file);
        writeExtensionField = jest.fn(async (id, field, scripts) => {
            characters[id].data.extensions[field] = scripts;
        });
        fetch = jest.fn(async () => ({ ok: true, json: async () => ({ name: 'Preset' }) }));
        let id = 0;
        context = vm.createContext({
            console: { log: jest.fn(), error: jest.fn(), debug: jest.fn() },
            toastr: { success, error },
            fetch,
            selectedName: 'Preset',
            refreshRegexList: refresh,
        });
        const mocks = {
            characters, this_chid: 0, main_api: 'openai', selected_group: null,
            extension_settings: extensionSettings, lodash,
            oai_settings: settings, openai_settings: [preset], openai_setting_names: { Preset: 0 },
            getFileText: readFile, uuidv4: () => `new-id-${++id}`,
            ensurePlainObject: value => value,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            saveSettings: async () => { await fetch('/api/settings/save', { method: 'POST' }); },
            saveSettingsDebounced, writeExtensionField,
            t: (strings, ...values) => String.raw({ raw: strings }, ...values),
        };
        const modules = new Map();
        function load(url) {
            if (modules.has(url)) return modules.get(url);
            let module;
            if (sources.has(url)) {
                let source = sources.get(url);
                if (url === indexURL) {
                    source += '\nloadRegexScripts = refreshRegexList; export { onRegexImportFilesChange as importFiles };';
                } else if (url === managerURL) {
                    source += '\npresetManagers.openai = new PresetManager(null, "openai"); presetManagers.openai.getSelectedPresetName = () => selectedName;';
                }
                module = new vm.SourceTextModule(source, { context, identifier: url });
            } else {
                const names = [...dependencyExports.get(url)];
                module = new vm.SyntheticModule(names, function () {
                    for (const name of names) this.setExport(name, mocks[name]);
                }, { context, identifier: url });
            }
            modules.set(url, module);
            return module;
        }
        const module = load(indexURL);
        await module.link((specifier, parent) => load(new URL(specifier, parent.identifier).href));
        await module.evaluate();
        importFiles = module.namespace.importFiles;
    });

    test('imports 20 preset rules with one settings save, one preset save and one refresh', async () => {
        const rules = Array.from({ length: 20 }, (_, i) => rule(`Rule ${i}`));

        await importFiles([JSON.stringify(rules)], 2);

        expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/settings/save', '/api/presets/save']);
        const saved = JSON.parse(fetch.mock.calls[1][1].body);
        expect(saved.preset.extensions.regex_scripts.map(script => script.scriptName)).toEqual(['Existing', ...rules.map(script => script.scriptName)]);
        expect(new Set(saved.preset.extensions.regex_scripts.map(script => script.id)).size).toBe(21);
        expect(saved.preset.extensions.regex_scripts.slice(1)).toEqual(rules.map((script, i) => ({ ...script, id: `new-id-${i + 1}` })));
        expect(settings.extensions.regex_scripts).toEqual(preset.extensions.regex_scripts);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(success).toHaveBeenCalledTimes(1);
        expect(success).toHaveBeenCalledWith('Imported 20 regex scripts.');
        expect(error).not.toHaveBeenCalled();
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('combines multiple files, single objects and arrays in selection order', async () => {
        await importFiles([JSON.stringify(rule('First')), JSON.stringify([rule('Second'), rule('Third')])], 2);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(preset.extensions.regex_scripts.map(script => script.scriptName)).toEqual(['Existing', 'First', 'Second', 'Third']);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(success).toHaveBeenCalledTimes(1);
    });

    test('schedules only one settings save for global rules', async () => {
        await importFiles([JSON.stringify([rule('First'), rule('Second')])], 0);

        expect(extensionSettings.regex.map(script => script.scriptName)).toEqual(['Existing', 'First', 'Second']);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(fetch).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test('writes scoped rules to the character only once', async () => {
        await importFiles([JSON.stringify([rule('First'), rule('Second')])], 1);

        expect(writeExtensionField).toHaveBeenCalledTimes(1);
        expect(characters[0].data.extensions.regex_scripts).toHaveLength(3);
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(fetch).not.toHaveBeenCalled();
    });

    test.each([null, 42, [], {}, { scriptName: '' }, { scriptName: ' ' }])('rejects malformed rules before saving any part of the batch: %p', async invalid => {
        await importFiles([JSON.stringify([rule('Valid'), invalid])], 2);

        expect(fetch).not.toHaveBeenCalled();
        expect(preset.extensions.regex_scripts).toHaveLength(1);
        expect(settings.extensions.regex_scripts).toHaveLength(1);
        expect(refresh).not.toHaveBeenCalled();
        expect(success).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(1);
    });

    test('a malformed later file does not leave earlier files imported', async () => {
        await importFiles([JSON.stringify(rule('Valid')), '{invalid json'], 2);

        expect(fetch).not.toHaveBeenCalled();
        expect(preset.extensions.regex_scripts).toHaveLength(1);
        expect(error).toHaveBeenCalledWith('Invalid JSON file.');
        expect(success).not.toHaveBeenCalled();
    });

    test('does not write an empty array', async () => {
        await importFiles(['[]'], 2);

        expect(fetch).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(success).not.toHaveBeenCalled();
    });

    test('retains the single-rule success message', async () => {
        await importFiles([JSON.stringify(rule('Single'))], 2);

        expect(success).toHaveBeenCalledWith('Regex script "Single" imported.');
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test('does not report success or retry the batch after a preset save fails', async () => {
        fetch.mockImplementation(async url => ({ ok: url !== '/api/presets/save' }));

        await importFiles([JSON.stringify([rule('First'), rule('Second')])], 2);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(success).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(error).toHaveBeenLastCalledWith('Regex scripts could not be imported.');
    });

    test('does not import into a preset selected while reading files', async () => {
        readFile.mockImplementation(async file => {
            context.selectedName = 'Other preset';
            return file;
        });

        await importFiles([JSON.stringify(rule('Rule'))], 2);

        expect(fetch).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith('The import target changed. Please import the files again.');
    });

    test('does not import into a character selected while reading files', async () => {
        readFile.mockImplementation(async file => {
            characters[0] = { avatar: 'other.png' };
            return file;
        });

        await importFiles([JSON.stringify(rule('Rule'))], 1);

        expect(writeExtensionField).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith('The import target changed. Please import the files again.');
    });
});
