import * as vscode from 'vscode';
import { ResourcesEditorProvider } from './resourcesEditor';

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(ResourcesEditorProvider.register(context));

    context.subscriptions.push(
        vscode.commands.registerCommand('dotnetResources.openWithViewer', async (uri?: vscode.Uri) => {
            let target = uri instanceof vscode.Uri ? uri : activeTabUri();
            if (!target) {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    openLabel: 'Open .resources',
                    filters: { '.NET resources': ['resources'], 'All files': ['*'] },
                });
                target = picked?.[0];
            }
            if (target) {
                await vscode.commands.executeCommand('vscode.openWith', target, ResourcesEditorProvider.viewType);
            }
        }),
    );
}

function activeTabUri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
        return input.uri;
    }
    return undefined;
}

export function deactivate(): void {
    // nothing to clean up
}
