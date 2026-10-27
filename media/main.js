// @ts-check
(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');

    const saved = vscode.getState() || {};
    const state = {
        model: null,
        tab: saved.tab || 'resources',
        selected: typeof saved.selected === 'number' ? saved.selected : -1,
        filter: saved.filter || '',
        kindFilter: saved.kindFilter || '',
        sortKey: saved.sortKey || 'index',
        sortDir: saved.sortDir || 1,
        detail: null,
        regionHex: null,
    };

    function persist() {
        vscode.setState({ tab: state.tab, selected: state.selected, filter: state.filter, kindFilter: state.kindFilter, sortKey: state.sortKey, sortDir: state.sortDir });
    }

    // ---------- helpers ----------
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const hex = (n, pad = 8) => (n < 0 ? '—' : '0x' + (n >>> 0).toString(16).toUpperCase().padStart(pad, '0'));
    const hex32 = (n) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const num = (n) => Number(n).toLocaleString('en-US');
    const size = (n) => {
        if (n < 1024) return `${num(n)} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(2)} MB`;
    };
    const shortType = (t) => String(t || '').split(',')[0];

    function hexDump(base64, offset) {
        const bin = atob(base64);
        const lines = [];
        for (let i = 0; i < bin.length; i += 16) {
            let hx = '';
            let asc = '';
            for (let j = 0; j < 16; j++) {
                if (i + j < bin.length) {
                    const b = bin.charCodeAt(i + j);
                    hx += b.toString(16).padStart(2, '0').toUpperCase() + (j === 7 ? '  ' : ' ');
                    asc += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
                } else {
                    hx += j === 7 ? '    ' : '   ';
                }
            }
            lines.push(`${(offset + i).toString(16).toUpperCase().padStart(8, '0')}  ${hx} ${asc}`);
        }
        return lines.join('\n');
    }

    function hexBlock(title, h) {
        if (!h) return '';
        const shown = atob(h.data).length;
        const note = h.total > shown ? ` <span class="muted">(showing first ${num(shown)} of ${num(h.total)} bytes)</span>` : ` <span class="muted">(${num(shown)} bytes)</span>`;
        return `<div class="section-title">${esc(title)}${note}</div><pre class="hex">${esc(hexDump(h.data, h.offset))}</pre>`;
    }

    const KIND_LABEL = { string: 'String', primitive: 'Primitive', null: 'Null', bytes: 'Byte[]', stream: 'Stream', object: 'Object', error: 'Error' };

    // ---------- rendering ----------
    function render() {
        const m = state.model;
        if (!m) {
            app.innerHTML = '<div class="loading">Parsing…</div>';
            return;
        }
        if (m.error) {
            app.innerHTML = `
                <div class="toolbar-top">${titleBlock(m)}</div>
                <div class="error-box">
                    <h2>Cannot parse this file</h2>
                    <p>${esc(m.error)}</p>
                    <p class="muted">File size: ${size(m.fileSize)}. .NET .resources files start with the magic number 0xBEEFCACE (bytes CE CA EF BE).</p>
                    <button data-action="reopenDefault">Open with default editor</button>
                    <button class="secondary" data-action="reload">Reload</button>
                </div>`;
            return;
        }
        const p = m.parsed;
        app.innerHTML = `
            <div class="toolbar-top">${titleBlock(m)}</div>
            ${p.warnings.length ? `<div class="warnings">${p.warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : ''}
            ${cards(p)}
            <div class="tabs">
                ${tabButton('resources', `Resources <span class="count">${num(p.numResources)}</span>`)}
                ${tabButton('headers', 'Headers')}
                ${tabButton('types', `Types <span class="count">${num(p.types.length)}</span>`)}
                ${tabButton('layout', 'Layout')}
            </div>
            <div class="tab-body" id="tab-body"></div>`;
        renderTab();
    }

    function titleBlock(m) {
        return `
            <div class="title">
                <div class="file-name">${esc(m.fileName)}</div>
                <div class="file-path muted">${esc(m.filePath)}</div>
            </div>
            <div class="actions">
                <button class="secondary" data-action="reload" title="Re-read the file from disk">Reload</button>
                <button class="secondary" data-action="reopenDefault" title="Open with VS Code's default editor">Open as text</button>
            </div>`;
    }

    function cards(p) {
        const errors = p.entries.filter((e) => e.error).length;
        const items = [
            ['File size', size(p.fileSize), `${num(p.fileSize)} bytes`],
            ['Resources', num(p.numResources), errors ? `${errors} with errors` : 'all decoded'],
            ['User types', num(p.types.length), p.types.length ? shortType(p.types[0].name) + (p.types.length > 1 ? ', …' : '') : 'none'],
            ['Format version', `V${p.version}`, `RuntimeResourceSet · header v${p.resMgrHeaderVersion}`],
            ['Reader', p.preserialized ? 'Deserializing' : 'ResourceReader', p.preserialized ? 'System.Resources.Extensions' : 'System.Resources'],
            ['Data section', hex(p.dataSectionOffset), `${size(p.fileSize - p.dataSectionOffset)} of data`],
            ['Name hashes', p.hashMismatches === 0 && p.hashesSorted ? 'Valid ✓' : 'Invalid ✗', p.hashesSorted ? `${p.hashMismatches} mismatches` : 'table not sorted'],
        ];
        return `<div class="cards">${items
            .map(([k, v, s]) => `<div class="card"><div class="card-label">${esc(k)}</div><div class="card-value">${esc(v)}</div><div class="card-sub muted">${esc(s)}</div></div>`)
            .join('')}</div>`;
    }

    function tabButton(id, label) {
        return `<button class="tab ${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`;
    }

    function renderTab() {
        const body = document.getElementById('tab-body');
        if (!body) return;
        const p = state.model.parsed;
        if (state.tab === 'headers') body.innerHTML = headersTab(p);
        else if (state.tab === 'types') body.innerHTML = typesTab(p);
        else if (state.tab === 'layout') {
            body.innerHTML = layoutTab(p);
            // CSP forbids inline style attributes; set segment widths through CSSOM.
            body.querySelectorAll('.seg[data-grow]').forEach((el) => {
                /** @type {HTMLElement} */ (el).style.flexGrow = el.getAttribute('data-grow') || '0';
            });
        } else {
            body.innerHTML = resourcesTab(p);
            renderRows();
            renderDetail();
        }
    }

    // ---------- resources tab ----------
    function resourcesTab(p) {
        const kinds = new Map();
        for (const e of p.entries) {
            const key = shortType(e.typeName);
            kinds.set(key, (kinds.get(key) || 0) + 1);
        }
        const options = [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `<option value="${esc(k)}" ${state.kindFilter === k ? 'selected' : ''}>${esc(k)} (${c})</option>`).join('');
        return `
            <div class="filter-bar">
                <input id="filter" type="search" placeholder="Filter by name or value…" value="${esc(state.filter)}">
                <select id="kind-filter"><option value="">All types</option>${options}</select>
                <span class="muted" id="row-count"></span>
            </div>
            <div class="split">
                <div class="table-wrap">
                    <table class="grid" id="res-table">
                        <thead><tr>
                            ${th('index', '#')}${th('name', 'Name')}${th('type', 'Type')}${th('dataSize', 'Size')}${th('dataAbsOffset', 'Offset')}${th('value', 'Value')}
                        </tr></thead>
                        <tbody id="rows"></tbody>
                    </table>
                </div>
                <div class="detail" id="detail"></div>
            </div>`;
    }

    function th(key, label) {
        const arrow = state.sortKey === key ? (state.sortDir > 0 ? ' ▲' : ' ▼') : '';
        return `<th data-sort="${key}" class="${key === 'dataSize' || key === 'dataAbsOffset' || key === 'index' ? 'num' : ''}">${label}${arrow}</th>`;
    }

    function visibleEntries() {
        const p = state.model.parsed;
        const f = state.filter.trim().toLowerCase();
        let list = p.entries.filter((e) => {
            if (state.kindFilter && shortType(e.typeName) !== state.kindFilter) return false;
            if (!f) return true;
            return e.name.toLowerCase().includes(f) || String(e.value || '').toLowerCase().includes(f);
        });
        const k = state.sortKey;
        const dir = state.sortDir;
        list = list.slice().sort((a, b) => {
            let va, vb;
            if (k === 'type') { va = shortType(a.typeName); vb = shortType(b.typeName); }
            else { va = a[k]; vb = b[k]; }
            if (typeof va === 'string') return dir * va.localeCompare(vb);
            return dir * ((va ?? 0) - (vb ?? 0));
        });
        return list;
    }

    function renderRows() {
        const tbody = document.getElementById('rows');
        if (!tbody) return;
        const list = visibleEntries();
        const total = state.model.parsed.entries.length;
        const count = document.getElementById('row-count');
        if (count) count.textContent = list.length === total ? `${num(total)} resources` : `${num(list.length)} of ${num(total)}`;
        tbody.innerHTML = list
            .map((e) => {
                const val = e.error ? `<span class="err">${esc(e.error)}</span>` : esc(e.value) + (e.valueTruncated ? '…' : '');
                return `<tr data-index="${e.index}" class="${e.index === state.selected ? 'selected' : ''}">
                    <td class="num muted">${e.index}</td>
                    <td class="name" title="${esc(e.name)}">${esc(e.name)}</td>
                    <td><span class="badge kind-${e.kind}" title="${esc(e.typeName)}">${esc(shortType(e.typeName))}</span></td>
                    <td class="num">${e.dataSize ? num(e.dataSize) : '—'}</td>
                    <td class="num mono">${hex(e.dataAbsOffset)}</td>
                    <td class="value" title="${esc(String(e.value || '').slice(0, 300))}">${e.image ? '🖼 ' : ''}${val}</td>
                </tr>`;
            })
            .join('');
    }

    function renderDetail() {
        const el = document.getElementById('detail');
        if (!el) return;
        const p = state.model.parsed;
        const e = p.entries[state.selected];
        if (!e) {
            el.innerHTML = '<div class="placeholder muted">Select a resource to see its value, layout and bytes.</div>';
            return;
        }
        const d = state.detail && state.detail.index === e.index ? state.detail : null;
        const hashOk = e.storedHash === e.computedHash;
        const meta = [
            ['Index', e.index],
            ['Type', e.typeName],
            ['Type code', e.typeCode < 0 && p.version === 2 ? '—' : `${e.typeCodeName} (${p.version === 2 ? '0x' + e.typeCode.toString(16).toUpperCase().padStart(2, '0') : e.typeCode})`],
            ['Kind', KIND_LABEL[e.kind] || e.kind],
            e.serializationFormat ? ['Serialization', e.serializationFormat] : null,
            ['Name record', `${hex(e.nameOffset)} · ${e.nameRecordSize} bytes`],
            ['Data offset', `${hex(e.dataOffset)} (relative) → ${hex(e.dataAbsOffset)}`],
            ['Record size', `${num(e.dataSize)} bytes`],
            ['Value bytes', e.valueOffset >= 0 ? `${hex(e.valueOffset)} · ${num(e.valueLength)} bytes` : '—'],
            ['Name hash', `${hex32(e.storedHash)} ${hashOk ? '<span class="ok">✓</span>' : `<span class="err">✗ computed ${hex32(e.computedHash)}</span>`}`],
            e.image ? ['Image', `${e.image.format} · ${num(e.image.length)} bytes at ${hex(e.image.offset)}<span id="img-dim"></span>`] : null,
        ].filter(Boolean);
        const nrbf = (d && d.nrbf) || e.nrbf;
        const nrbfRows = nrbf
            ? [
                ['NRBF root record', nrbf.rootRecord],
                nrbf.className ? ['Serialized class', nrbf.className] : null,
                nrbf.libraryName ? ['Assembly', nrbf.libraryName] : null,
                nrbf.memberNames ? ['Members', nrbf.memberNames.join(', ') || '(none)'] : null,
                ['Byte arrays', String(nrbf.byteArrays ? nrbf.byteArrays.length : nrbf.byteArrayCount)],
            ].filter(Boolean)
            : [];
        const showValue = e.kind === 'string' || e.kind === 'primitive' || e.kind === 'null';
        const value = d ? d.value : e.value;
        el.innerHTML = `
            <div class="detail-head">
                <div class="detail-name" title="${esc(e.name)}">${esc(e.name)}</div>
                <div class="detail-actions">
                    <button class="secondary small" data-copy-name="1">Copy name</button>
                    ${showValue ? '<button class="secondary small" data-action="copyValue">Copy value</button>' : ''}
                    <button class="secondary small" data-save="value">Export value</button>
                    ${e.image ? '<button class="secondary small" data-save="image">Export image</button>' : ''}
                    <button class="secondary small" data-save="record">Export raw record</button>
                </div>
            </div>
            ${e.error ? `<div class="error-inline">${esc(e.error)}</div>` : ''}
            <table class="kv">${meta.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${k === 'Name hash' || k === 'Image' ? v : esc(v)}</td></tr>`).join('')}</table>
            ${nrbfRows.length ? `<div class="section-title">BinaryFormatter payload</div><table class="kv">${nrbfRows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
            ${d && d.image ? `<div class="section-title">Preview</div><div class="image-box checker"><img id="preview-img" src="${d.image}" alt="${esc(e.name)}"></div>` : ''}
            ${showValue ? `<div class="section-title">Value${e.kind === 'string' ? ` <span class="muted">(${num((value || '').length)} chars${d && d.valueTruncated ? ', truncated' : ''})</span>` : ''}</div><pre class="value-box">${esc(value)}${!d && e.valueTruncated ? '…' : ''}</pre>` : ''}
            ${d ? hexBlock('Data record', d.hex) + hexBlock('Name record', d.nameHex) : '<div class="muted">Loading bytes…</div>'}`;
        const img = /** @type {HTMLImageElement|null} */ (document.getElementById('preview-img'));
        if (img) {
            img.addEventListener('load', () => {
                const dim = document.getElementById('img-dim');
                if (dim) dim.textContent = ` · ${img.naturalWidth}×${img.naturalHeight}px`;
            });
        }
    }

    function select(index) {
        state.selected = index;
        state.detail = null;
        persist();
        document.querySelectorAll('#rows tr.selected').forEach((tr) => tr.classList.remove('selected'));
        const tr = document.querySelector(`#rows tr[data-index="${index}"]`);
        if (tr) tr.classList.add('selected');
        renderDetail();
        vscode.postMessage({ type: 'detail', index });
    }

    // ---------- headers tab ----------
    function headersTab(p) {
        const rows = [
            ['ResourceManager header', null],
            ['MagicNumber', 0, hex32(p.magic), 'Int32 · always 0xBEEFCACE (CE CA EF BE)'],
            ['ResMgrHeaderVersion', 4, p.resMgrHeaderVersion, 'Int32 · 1 = reader/set type names follow'],
            ['NumBytesToSkip', 8, `${p.numBytesToSkip} bytes`, 'Int32 · size of the rest of this header'],
            ['ReaderType', 12, p.readerType ?? '(skipped)', 'String · class used to read the file'],
            ['ResourceSetType', null, p.resourceSetType ?? '(skipped)', 'String · ResourceSet class'],
            ['RuntimeResourceSet header', null],
            ['Version', 12 + p.numBytesToSkip, p.version, 'Int32 · 1 = type index values, 2 = ResourceTypeCode values'],
            ['NumResources', 16 + p.numBytesToSkip, num(p.numResources), 'Int32'],
            ['NumTypes', 20 + p.numBytesToSkip, num(p.types.length), 'Int32 · number of user type names'],
            ['Padding', p.paddingOffset, `${p.paddingSize} bytes`, 'aligns the hash table to 8 bytes'],
            ['NameHashes', p.hashTableOffset, `${num(p.numResources)} × Int32`, p.hashesSorted ? 'sorted ascending ✓' : 'NOT sorted ✗'],
            ['NamePositions', p.positionTableOffset, `${num(p.numResources)} × Int32`, 'offsets relative to the name section'],
            ['DataSectionOffset', p.positionTableOffset + p.numResources * 4, hex(p.dataSectionOffset), 'Int32 · absolute'],
            ['NameSectionOffset', null, hex(p.nameSectionOffset), 'computed: position after DataSectionOffset'],
        ];
        return `<table class="grid fields">
            <thead><tr><th>Field</th><th class="num">Offset</th><th>Value</th><th>Description</th></tr></thead>
            <tbody>${rows
                .map((r) => (r[1] === null && r.length === 2
                    ? `<tr class="group"><td colspan="4">${esc(r[0])}</td></tr>`
                    : `<tr><td class="mono">${esc(r[0])}</td><td class="num mono">${r[1] === null ? '' : hex(r[1])}</td><td class="mono">${esc(r[2])}</td><td class="muted">${esc(r[3])}</td></tr>`))
                .join('')}</tbody></table>`;
    }

    // ---------- types tab ----------
    function typesTab(p) {
        const counts = new Map();
        for (const e of p.entries) {
            const k = shortType(e.typeName);
            counts.set(k, (counts.get(k) || 0) + 1);
        }
        const badges = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `<span class="pill">${esc(k)} <b>×${num(c)}</b></span>`).join('');
        const table = p.types.length
            ? `<table class="grid">
                <thead><tr><th class="num">Index</th><th class="num">${p.version === 2 ? 'Type code' : 'Type index'}</th><th>Type name</th><th class="num">Offset</th><th class="num">Used by</th></tr></thead>
                <tbody>${p.types
                    .map((t) => `<tr><td class="num">${t.index}</td><td class="num mono">${p.version === 2 ? '0x' + (0x40 + t.index).toString(16).toUpperCase() : t.index}</td><td class="mono wrap">${esc(t.name)}</td><td class="num mono">${hex(t.offset)}</td><td class="num">${num(t.count)}</td></tr>`)
                    .join('')}</tbody></table>`
            : '<p class="muted">The type table is empty: all values use built-in ResourceTypeCode primitives.</p>';
        return `<div class="section-title">Value types in this file</div><div class="pills">${badges || '<span class="muted">none</span>'}</div>
            <div class="section-title">Type table</div>${table}`;
    }

    // ---------- layout tab ----------
    function layoutTab(p) {
        const total = p.fileSize || 1;
        const bar = p.regions
            .map((r, i) => `<div class="seg seg-${i % 8}" data-grow="${Math.max(r.size / total, 0.004)}" title="${esc(r.name)}: ${num(r.size)} bytes" data-region="${i}"></div>`)
            .join('');
        const rows = p.regions
            .map((r, i) => `<tr data-region="${i}" class="clickable"><td><span class="swatch seg-${i % 8}"></span>${esc(r.name)}</td><td class="num mono">${hex(r.offset)}</td><td class="num mono">${hex(r.offset + r.size)}</td><td class="num">${num(r.size)}</td><td class="num">${((r.size / total) * 100).toFixed(1)}%</td><td class="muted">${esc(r.detail || '')}</td></tr>`)
            .join('');
        const rh = state.regionHex;
        return `<div class="layout-bar">${bar}</div>
            <table class="grid"><thead><tr><th>Region</th><th class="num">Start</th><th class="num">End</th><th class="num">Size</th><th class="num">%</th><th>Content</th></tr></thead><tbody>${rows}</tbody></table>
            <div id="region-hex">${rh ? hexBlock(rh.title, rh) : '<p class="muted">Click a region to see its bytes.</p>'}</div>`;
    }

    // ---------- events ----------
    let pendingRegionTitle = '';
    app.addEventListener('click', (ev) => {
        const t = /** @type {HTMLElement} */ (ev.target);
        const tab = t.closest('[data-tab]');
        if (tab) {
            state.tab = tab.getAttribute('data-tab');
            persist();
            render();
            if (state.tab === 'resources' && state.selected >= 0) vscode.postMessage({ type: 'detail', index: state.selected });
            return;
        }
        const action = t.closest('[data-action]');
        if (action) {
            const a = action.getAttribute('data-action');
            if (a === 'copyValue') vscode.postMessage({ type: 'copyValue', index: state.selected });
            else vscode.postMessage({ type: a });
            return;
        }
        const sv = t.closest('[data-save]');
        if (sv) {
            vscode.postMessage({ type: 'save', index: state.selected, what: sv.getAttribute('data-save') });
            return;
        }
        if (t.closest('[data-copy-name]')) {
            const e = state.model.parsed.entries[state.selected];
            if (e) vscode.postMessage({ type: 'copy', text: e.name });
            return;
        }
        const sort = t.closest('[data-sort]');
        if (sort) {
            const key = sort.getAttribute('data-sort');
            if (state.sortKey === key) state.sortDir = -state.sortDir;
            else { state.sortKey = key; state.sortDir = 1; }
            persist();
            document.querySelectorAll('#res-table thead th').forEach((el) => {
                const k = el.getAttribute('data-sort');
                el.textContent = el.textContent.replace(/ [▲▼]$/, '') + (k === state.sortKey ? (state.sortDir > 0 ? ' ▲' : ' ▼') : '');
            });
            renderRows();
            return;
        }
        const row = t.closest('#rows tr[data-index]');
        if (row) {
            select(Number(row.getAttribute('data-index')));
            return;
        }
        const region = t.closest('[data-region]');
        if (region) {
            const r = state.model.parsed.regions[Number(region.getAttribute('data-region'))];
            pendingRegionTitle = `${r.name} @ ${hex(r.offset)}`;
            vscode.postMessage({ type: 'hex', offset: r.offset, length: r.size });
        }
    });

    app.addEventListener('input', (ev) => {
        const t = /** @type {HTMLInputElement} */ (ev.target);
        if (t.id === 'filter') {
            state.filter = t.value;
            persist();
            renderRows();
        }
    });

    app.addEventListener('change', (ev) => {
        const t = /** @type {HTMLSelectElement} */ (ev.target);
        if (t.id === 'kind-filter') {
            state.kindFilter = t.value;
            persist();
            renderRows();
        }
    });

    app.addEventListener('keydown', (ev) => {
        if (state.tab !== 'resources' || !(ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) return;
        if (/** @type {HTMLElement} */ (ev.target).tagName === 'INPUT') return;
        const list = visibleEntries();
        if (!list.length) return;
        const pos = list.findIndex((e) => e.index === state.selected);
        const next = ev.key === 'ArrowDown' ? Math.min(list.length - 1, pos + 1) : Math.max(0, pos - 1);
        ev.preventDefault();
        select(list[next].index);
        const tr = document.querySelector(`#rows tr[data-index="${list[next].index}"]`);
        if (tr) tr.scrollIntoView({ block: 'nearest' });
    });

    window.addEventListener('message', (ev) => {
        const msg = ev.data;
        if (msg.type === 'model') {
            state.model = msg;
            state.detail = null;
            state.regionHex = null;
            if (msg.parsed && state.selected >= msg.parsed.entries.length) state.selected = -1;
            render();
            if (msg.parsed && state.tab === 'resources' && state.selected >= 0) vscode.postMessage({ type: 'detail', index: state.selected });
        } else if (msg.type === 'detail') {
            if (msg.index === state.selected) {
                state.detail = msg;
                renderDetail();
            }
        } else if (msg.type === 'hex') {
            state.regionHex = { ...msg, title: pendingRegionTitle };
            const el = document.getElementById('region-hex');
            if (el) el.innerHTML = hexBlock(pendingRegionTitle, msg);
        }
    });

    // keep focusable for arrow-key navigation
    app.tabIndex = 0;
    vscode.postMessage({ type: 'ready' });
})();
