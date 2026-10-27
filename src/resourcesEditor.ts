import * as path from 'path';
import * as vscode from 'vscode';
import { ResourcesFile, parseResources } from './resourcesParser';

/** Longest value preview sent with the initial model; full values are fetched on demand. */
const PREVIEW_CHARS = 300;
/** Largest string value sent to the webview at once. */
const MAX_DETAIL_CHARS = 2_000_000;
/** Bytes shown in a hex dump. */
const HEX_BYTES = 64 * 1024;
/** Largest image rendered inline. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

class ResourcesDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}
    dispose(): void {
        // no resources held
    }
}

interface LoadedFile {
    buf: Buffer;
    parsed?: ResourcesFile;
    error?: string;
}

type WebviewMessage =
    | { type: 'ready' }
    | { type: 'detail'; index: number }
    | { type: 'hex'; offset: number; length: number }
    | { type: 'save'; index: number; what: 'value' | 'image' | 'record' }
    | { type: 'copy'; text: string }
    | { type: 'copyValue'; index: number }
    | { type: 'reopenDefault' }
    | { type: 'reload' };

export class ResourcesEditorProvider implements vscode.CustomReadonlyEditorProvider<ResourcesDocument> {
    static readonly viewType = 'dotnetResources.viewer';

    static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(ResourcesEditorProvider.viewType, new ResourcesEditorProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: true,
        });
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    openCustomDocument(uri: vscode.Uri): ResourcesDocument {
        return new ResourcesDocument(uri);
    }

    async resolveCustomEditor(document: ResourcesDocument, panel: vscode.WebviewPanel): Promise<void> {
        const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
        panel.webview.html = this.getHtml(panel.webview, mediaRoot);

        let loaded: LoadedFile = await load(document.uri);
        const post = (msg: unknown) => panel.webview.postMessage(msg);
        const sendModel = () => post({ type: 'model', fileName: path.basename(document.uri.fsPath || document.uri.path), filePath: document.uri.fsPath, ...toModel(loaded) });

        const disposables: vscode.Disposable[] = [];
        if (document.uri.scheme === 'file') {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(path.dirname(document.uri.fsPath)), path.basename(document.uri.fsPath)),
            );
            const reload = async () => {
                loaded = await load(document.uri);
                sendModel();
            };
            disposables.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload));
        }

        disposables.push(
            panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
                try {
                    switch (msg.type) {
                        case 'ready':
                            sendModel();
                            break;
                        case 'reload':
                            loaded = await load(document.uri);
                            sendModel();
                            break;
                        case 'detail':
                            post({ type: 'detail', ...detail(loaded, msg.index) });
                            break;
                        case 'hex': {
                            const start = Math.max(0, Math.min(msg.offset, loaded.buf.length));
                            const len = Math.max(0, Math.min(msg.length, HEX_BYTES, loaded.buf.length - start));
                            post({ type: 'hex', offset: start, total: msg.length, data: loaded.buf.subarray(start, start + len).toString('base64') });
                            break;
                        }
                        case 'save':
                            await save(loaded, msg.index, msg.what, document.uri);
                            break;
                        case 'copy':
                            await vscode.env.clipboard.writeText(msg.text);
                            vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
                            break;
                        case 'copyValue': {
                            const e = loaded.parsed?.entries[msg.index];
                            if (e) {
                                await vscode.env.clipboard.writeText(e.value ?? '');
                                vscode.window.setStatusBarMessage(`Copied value of "${e.name}"`, 2000);
                            }
                            break;
                        }
                        case 'reopenDefault':
                            await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                            break;
                    }
                } catch (err) {
                    vscode.window.showErrorMessage(`.NET Resources Viewer: ${(err as Error).message}`);
                }
            }),
        );
        panel.onDidDispose(() => disposables.forEach(d => d.dispose()));
    }

    private getHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
        const nonce = makeNonce();
        const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>.NET Resources</title>
</head>
<body>
<div id="app"><div class="loading">Parsing…</div></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}

async function load(uri: vscode.Uri): Promise<LoadedFile> {
    const buf = Buffer.from(await vscode.workspace.fs.readFile(uri));
    try {
        return { buf, parsed: parseResources(buf) };
    } catch (e) {
        return { buf, error: (e as Error).message };
    }
}

function toModel(loaded: LoadedFile) {
    if (!loaded.parsed) {
        return { fileSize: loaded.buf.length, error: loaded.error };
    }
    const p = loaded.parsed;
    const entries = p.entries.map(e => {
        const { nrbf, ...rest } = e;
        const value = e.value ?? '';
        return {
            ...rest,
            value: value.length > PREVIEW_CHARS ? value.slice(0, PREVIEW_CHARS) : value,
            valueTruncated: value.length > PREVIEW_CHARS,
            valueChars: value.length,
            nrbf: nrbf && { rootRecord: nrbf.rootRecord, className: nrbf.className, libraryName: nrbf.libraryName, memberNames: nrbf.memberNames, byteArrayCount: nrbf.byteArrays.length },
        };
    });
    return { fileSize: p.fileSize, parsed: { ...p, entries } };
}

function detail(loaded: LoadedFile, index: number) {
    const e = loaded.parsed?.entries[index];
    if (!e) {
        return { index, error: 'Resource not found' };
    }
    const value = e.value ?? '';
    let image: string | undefined;
    if (e.image && e.image.length <= MAX_IMAGE_BYTES) {
        image = `data:${e.image.mime};base64,${loaded.buf.subarray(e.image.offset, e.image.offset + e.image.length).toString('base64')}`;
    }
    const hexStart = e.dataAbsOffset >= 0 ? e.dataAbsOffset : e.nameOffset;
    const hexLen = e.dataAbsOffset >= 0 ? Math.min(e.dataSize, HEX_BYTES) : Math.min(e.nameRecordSize || 64, HEX_BYTES);
    return {
        index,
        value: value.length > MAX_DETAIL_CHARS ? value.slice(0, MAX_DETAIL_CHARS) : value,
        valueTruncated: value.length > MAX_DETAIL_CHARS,
        image,
        nrbf: e.nrbf,
        hex: { offset: hexStart, total: e.dataAbsOffset >= 0 ? e.dataSize : hexLen, data: loaded.buf.subarray(hexStart, hexStart + hexLen).toString('base64') },
        nameHex: { offset: e.nameOffset, total: e.nameRecordSize, data: loaded.buf.subarray(e.nameOffset, e.nameOffset + Math.min(e.nameRecordSize, HEX_BYTES)).toString('base64') },
    };
}

const IMAGE_EXT: Record<string, string> = { PNG: 'png', GIF: 'gif', JPEG: 'jpg', BMP: 'bmp', ICO: 'ico', CUR: 'cur', WebP: 'webp', SVG: 'svg' };

async function save(loaded: LoadedFile, index: number, what: 'value' | 'image' | 'record', source: vscode.Uri): Promise<void> {
    const e = loaded.parsed?.entries[index];
    if (!e) {
        return;
    }
    let data: Uint8Array;
    let ext: string;
    if (what === 'image' && e.image) {
        data = loaded.buf.subarray(e.image.offset, e.image.offset + e.image.length);
        ext = IMAGE_EXT[e.image.format] ?? 'bin';
    } else if (what === 'record') {
        data = loaded.buf.subarray(e.dataAbsOffset, e.dataAbsOffset + e.dataSize);
        ext = 'bin';
    } else if (e.kind === 'string' || e.kind === 'primitive' || e.kind === 'null') {
        data = Buffer.from(e.value ?? '', 'utf8');
        ext = 'txt';
    } else {
        data = loaded.buf.subarray(e.valueOffset, e.valueOffset + e.valueLength);
        ext = e.image ? IMAGE_EXT[e.image.format] ?? 'bin' : 'bin';
    }
    const safeName = e.name.replace(/[\\/:*?"<>|]+/g, '_') || `resource${index}`;
    const dir = source.scheme === 'file' ? vscode.Uri.file(path.dirname(source.fsPath)) : undefined;
    const target = await vscode.window.showSaveDialog({
        defaultUri: dir ? vscode.Uri.joinPath(dir, `${safeName}.${ext}`) : undefined,
        saveLabel: 'Export',
    });
    if (target) {
        await vscode.workspace.fs.writeFile(target, data);
        vscode.window.showInformationMessage(`Exported "${e.name}" (${data.length.toLocaleString('en-US')} bytes) to ${target.fsPath}`);
    }
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) {
        s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
}
