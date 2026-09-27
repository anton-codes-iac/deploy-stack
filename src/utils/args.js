function toKey(name) {
    return name
        .split('-')
        .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join('');
}

// Accepts flag entries as bare names (`'project-name'` → `projectName`) or
// explicit `{ name, key }` pairs for keys that diverge (e.g. `--headless`).
function normalizeEntries(entries) {
    const map = new Map();
    for (const entry of entries || []) {
        if (typeof entry === 'string') {
            map.set(entry, toKey(entry));
        } else if (entry && typeof entry.name === 'string') {
            map.set(entry.name, entry.key || toKey(entry.name));
        }
    }
    return map;
}

// Declarative CLI flag parsing shared by every command module.
//
// - `string`: `--name value` or `--name=value` (last one wins; a trailing
//   `--name` with no value is dropped, matching the hand-written parsers).
// - `number`: like `string` but coerced with `Number()`.
// - `boolean`: bare `--name` means `true`; `--name=<v>` is `v === 'true'`.
// - `bareBoolean`: bare `--name` only; any `=value` form is ignored.
// - `alias`: single-dash shorthands (`{ f: 'follow' }` makes `-f` act as
//   the bare long flag).
//
// Unknown `--flags` are dropped and everything else is returned in `rest`
// so each command can apply its own positional rules.
export function parseFlags(args, { string = [], number = [], boolean = [], bareBoolean = [], alias = {} } = {}) {
    const options = {};
    const rest = [];
    const strings = normalizeEntries(string);
    const numbers = normalizeEntries(number);
    const booleans = normalizeEntries(boolean);
    const bares = normalizeEntries(bareBoolean);
    const list = Array.isArray(args) ? args : [];
    for (let i = 0; i < list.length; i++) {
        let arg = list[i];
        if (typeof arg !== 'string') {
            rest.push(arg);
            continue;
        }
        if (arg.length === 2 && arg[0] === '-' && Object.prototype.hasOwnProperty.call(alias, arg[1])) {
            arg = `--${alias[arg[1]]}`;
        }
        if (!arg.startsWith('--')) {
            rest.push(arg);
            continue;
        }
        const eq = arg.indexOf('=');
        const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
        const value = eq === -1 ? undefined : arg.slice(eq + 1);
        if (strings.has(name)) {
            if (value !== undefined) options[strings.get(name)] = value;
            else if (i + 1 < list.length) options[strings.get(name)] = list[++i];
            continue;
        }
        if (numbers.has(name)) {
            if (value !== undefined) options[numbers.get(name)] = Number(value);
            else if (i + 1 < list.length) options[numbers.get(name)] = Number(list[++i]);
            continue;
        }
        if (booleans.has(name)) {
            options[booleans.get(name)] = value === undefined ? true : value === 'true';
            continue;
        }
        if (bares.has(name)) {
            if (value === undefined) options[bares.get(name)] = true;
            continue;
        }
    }
    return { options, rest };
}
