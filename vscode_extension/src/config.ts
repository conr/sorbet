import {
  ConfigurationChangeEvent,
  Disposable,
  Event,
  EventEmitter,
  ExtensionContext,
  FileSystemWatcher,
  Memento,
  workspace,
  WorkspaceFolder,
} from "vscode";
import * as fs from "fs";
import { SorbetLspConfig, SorbetLspConfigData } from "./sorbetLspConfig";
import { deepEqual } from "./utils";

export interface SorbetLspConfigChangeEvent {
  readonly oldLspConfig: SorbetLspConfig | undefined;
  readonly newLspConfig: SorbetLspConfig | undefined;
}

/**
 * Combines references to `extensionContext.workspaceState()`,
 * `workspace.getConfiguration("sorbet")`, and
 * `workspace.onDidChangeConfiguration` for the "sorbet" section
 * to make it easier to stub out behavior in tests.
 */
export interface ISorbetWorkspaceContext extends Disposable {
  /** See `vscode.Memento.get`. */
  get<T>(section: string, defaultValue: T): T;

  /** See `vscode.Memento.update`. */
  update(section: string, value: any): Thenable<void>;

  /** See `vscode.workspace.onDidChangeConfiguration` */
  onDidChangeConfiguration: Event<ConfigurationChangeEvent>;

  initializeEnabled(enabled: boolean): void;
}

/** Default implementation accesses `workspace` directly. */
export class DefaultSorbetWorkspaceContext implements ISorbetWorkspaceContext {
  private cachedSorbetConfiguration;
  private readonly disposables: Disposable[];
  private readonly workspaceState: Memento;
  private readonly onDidChangeConfigurationEmitter: EventEmitter<
    ConfigurationChangeEvent
  >;

  constructor(extensionContext: ExtensionContext) {
    this.cachedSorbetConfiguration = workspace.getConfiguration("sorbet");
    this.onDidChangeConfigurationEmitter = new EventEmitter<
      ConfigurationChangeEvent
    >();
    this.workspaceState = extensionContext.workspaceState;

    this.disposables = [
      workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("sorbet")) {
          // update the cached configuration before firing
          this.cachedSorbetConfiguration = workspace.getConfiguration("sorbet");
          this.onDidChangeConfigurationEmitter.fire(e);
        }
      }),
    ];
  }

  /**
   * Dispose and free associated resources.
   */
  public dispose() {
    Disposable.from(...this.disposables).dispose();
  }

  public get<T>(section: string, defaultValue: T): T {
    const workspaceStateValue = this.workspaceState.get<T>(`sorbet.${section}`);
    if (workspaceStateValue !== undefined) {
      return workspaceStateValue;
    }
    return this.cachedSorbetConfiguration.get(section, defaultValue);
  }

  public async update(section: string, value: any): Promise<void> {
    const key = `sorbet.${section}`;
    await this.workspaceState.update(key, value);
    this.onDidChangeConfigurationEmitter.fire({
      affectsConfiguration: () => true,
    });
  }

  public get onDidChangeConfiguration(): Event<ConfigurationChangeEvent> {
    return this.onDidChangeConfigurationEmitter.event;
  }

  public workspaceFolders(): readonly WorkspaceFolder[] | undefined {
    return workspace.workspaceFolders;
  }

  /**
   * This function is a workaround to make it possible to enable Sorbet on first launch.
   *
   * The `sorbet.enabled` setting always has its default value set to `false` from `package.json` and cannot be
   * undefined. That means that invoking `workspaceContext.get("enabled", this.enabled)` will always return `false` on
   * first launch regardless of the value of `this.enabled`.
   *
   * To workaround this, we check if `sorbet.enabled` is still undefined in the workspace state and in every type of
   * configuration other than the `defaultValue`. If that's the case, then we can update the workspace state and enable
   * Sorbet on first launch.
   */
  public async initializeEnabled(enabled: boolean): Promise<void> {
    const stateEnabled = this.workspaceState.get<boolean>("sorbet.enabled");

    if (stateEnabled === undefined) {
      const cachedConfig = this.cachedSorbetConfiguration.inspect<boolean>(
        "enabled",
      );

      if (
        cachedConfig === undefined ||
        (cachedConfig.globalValue === undefined &&
          cachedConfig.workspaceValue === undefined &&
          cachedConfig.workspaceFolderValue === undefined &&
          cachedConfig.globalLanguageValue === undefined &&
          cachedConfig.workspaceFolderLanguageValue === undefined &&
          cachedConfig.workspaceLanguageValue === undefined)
      ) {
        await this.update("enabled", enabled);
      }
    }
  }
}

export class SorbetExtensionConfig implements Disposable {
  private configFilePatterns: ReadonlyArray<string>;
  private configFileWatchers: ReadonlyArray<FileSystemWatcher>;
  private readonly disposables: Disposable[];
  private readonly onLspConfigChangeEmitter: EventEmitter<
    SorbetLspConfigChangeEvent
  >;

  private selectedLspConfigId?: string;
  private readonly sorbetWorkspaceContext: ISorbetWorkspaceContext;
  /** "Standard" LSP configs. */
  private standardLspConfigs: ReadonlyArray<SorbetLspConfig>;
  /** "Custom" LSP configs that override/supplement "standard" LSP configs. */
  private userLspConfigs: ReadonlyArray<SorbetLspConfig>;
  private wrappedEnabled: boolean;
  private wrappedHighlightUntyped: boolean;
  private wrappedTypedFalseCompletionNudges: boolean;
  private wrappedRevealOutputOnError: boolean;

  constructor(sorbetWorkspaceContext: ISorbetWorkspaceContext) {
    this.configFilePatterns = [];
    this.configFileWatchers = [];
    this.onLspConfigChangeEmitter = new EventEmitter<
      SorbetLspConfigChangeEvent
    >();
    this.sorbetWorkspaceContext = sorbetWorkspaceContext;
    this.standardLspConfigs = [];
    this.userLspConfigs = [];
    this.wrappedHighlightUntyped = false;
    this.wrappedTypedFalseCompletionNudges = true;
    this.wrappedRevealOutputOnError = false;

    // Any workspace with a `…/sorbet/config` file is considered Sorbet-enabled
    // by default. This implementation does not work in the general case with
    // multi-root workspaces.
    const { workspaceFolders } = workspace;
    this.wrappedEnabled =
      !!workspaceFolders?.length &&
      fs.existsSync(`${workspaceFolders[0].uri.fsPath}/sorbet/config`);

    this.disposables = [
      this.onLspConfigChangeEmitter,
      this.sorbetWorkspaceContext.onDidChangeConfiguration(() =>
        this.refresh(),
      ),
      {
        dispose: () => Disposable.from(...this.configFileWatchers).dispose(),
      },
    ];

    this.sorbetWorkspaceContext.initializeEnabled(this.wrappedEnabled);
    this.refresh();
  }

  /**
   * Dispose and free associated resources.
   */
  public dispose() {
    Disposable.from(...this.disposables).dispose();
  }

  /**
   * Refreshes the configuration from {@link sorbetWorkspaceContext},
   * emitting change events as necessary.
   */
  private refresh(): void {
    const oldLspConfig = this.activeLspConfig;
    const oldConfigFilePatterns = this.configFilePatterns;

    this.configFilePatterns = this.sorbetWorkspaceContext.get(
      "configFilePatterns",
      this.configFilePatterns,
    );
    this.wrappedEnabled = this.sorbetWorkspaceContext.get(
      "enabled",
      this.enabled,
    );
    this.wrappedRevealOutputOnError = this.sorbetWorkspaceContext.get(
      "revealOutputOnError",
      this.revealOutputOnError,
    );
    this.wrappedHighlightUntyped = this.sorbetWorkspaceContext.get(
      "highlightUntyped",
      this.highlightUntyped,
    );
    this.wrappedTypedFalseCompletionNudges = this.sorbetWorkspaceContext.get(
      "typedFalseCompletionNudges",
      this.typedFalseCompletionNudges,
    );

    Disposable.from(...this.configFileWatchers).dispose();
    this.configFileWatchers = this.configFilePatterns.map((pattern) => {
      const watcher = workspace.createFileSystemWatcher(pattern);
      const onConfigChange = () => {
        const c = this.activeLspConfig;
        this.onLspConfigChangeEmitter.fire({
          oldLspConfig: c,
          newLspConfig: c,
        });
      };
      watcher.onDidChange(onConfigChange);
      watcher.onDidCreate(onConfigChange);
      watcher.onDidDelete(onConfigChange);
      return watcher;
    });

    this.standardLspConfigs = this.sorbetWorkspaceContext
      .get<SorbetLspConfigData[]>("lspConfigs", [])
      .map((c) => new SorbetLspConfig(c));

    this.userLspConfigs = this.sorbetWorkspaceContext
      .get<SorbetLspConfigData[]>("userLspConfigs", [])
      .map((c) => new SorbetLspConfig(c));

    this.selectedLspConfigId = this.sorbetWorkspaceContext.get<
      string | undefined
    >("selectedLspConfigId", undefined);

    // Ensure `selectedLspConfigId` is a valid Id (not `undefined` or empty)
    if (!this.selectedLspConfigId) {
      this.selectedLspConfigId = this.lspConfigs[0]?.id;
    }

    const newLspConfig = this.activeLspConfig;
    if (
      !SorbetLspConfig.areEqual(oldLspConfig, newLspConfig) ||
      !deepEqual(oldConfigFilePatterns, this.configFilePatterns)
    ) {
      this.onLspConfigChangeEmitter.fire({
        oldLspConfig,
        newLspConfig,
      });
    }
  }

  /**
   * An event that fires when the (effective) active configuration changes.
   */
  public get onLspConfigChange(): Event<SorbetLspConfigChangeEvent> {
    return this.onLspConfigChangeEmitter.event;
  }

  /**
   * Get the active {@link SorbetLspConfig LSP config}.
   *
   * A {@link selectedLspConfig selected} config is only active when {@link enabled}
   * is `true`.
   */
  public get activeLspConfig(): SorbetLspConfig | undefined {
    return this.enabled ? this.selectedLspConfig : undefined;
  }

  public get enabled(): boolean {
    return this.wrappedEnabled;
  }

  public get highlightUntyped(): boolean {
    return this.wrappedHighlightUntyped;
  }

  /**
   * Returns a copy of the current SorbetLspConfig objects.
   */
  public get lspConfigs(): ReadonlyArray<SorbetLspConfig> {
    const results = new Map<string, SorbetLspConfig>(
      this.userLspConfigs.map((c) => [c.id, c]),
    );
    // Add missing, do not override
    this.standardLspConfigs.forEach(
      (c) => !results.has(c.id) && results.set(c.id, c),
    );
    return [...results.values()];
  }

  public get revealOutputOnError(): boolean {
    return this.wrappedRevealOutputOnError;
  }

  /**
   * Get the currently selected {@link SorbetLspConfig LSP config}.
   *
   * Returns `undefined` if {@link selectedLspConfigId} has not been set or if
   * its value does not map to a config in {@link lspConfigs}.
   */
  public get selectedLspConfig(): SorbetLspConfig | undefined {
    return this.lspConfigs.find((c) => c.id === this.selectedLspConfigId);
  }

  public get typedFalseCompletionNudges(): boolean {
    return this.wrappedTypedFalseCompletionNudges;
  }

  /**
   * Set active {@link SorbetLspConfig LSP config}.
   *
   * If {@link enabled} is `false`, this will change it to `true`.
   */
  public async setActiveLspConfigId(id: string): Promise<void> {
    const updates: Array<Thenable<void>> = [];

    if (this.activeLspConfig?.id !== id) {
      updates.push(
        this.sorbetWorkspaceContext.update("selectedLspConfigId", id),
      );
    }
    if (!this.enabled) {
      updates.push(this.sorbetWorkspaceContext.update("enabled", true));
    }

    if (updates.length) {
      await Promise.all(updates);
      this.refresh();
    }
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    await this.sorbetWorkspaceContext.update("enabled", enabled);
    this.refresh();
  }

  public async setHighlightUntyped(enabled: boolean): Promise<void> {
    await this.sorbetWorkspaceContext.update("highlightUntyped", enabled);
    this.refresh();
  }

  /**
   * Set selected {@link SorbetLspConfig LSP config}.
   *
   * This does not change {@link enabled}.
   */
  public async setSelectedLspConfigId(id: string): Promise<void> {
    if (this.selectedLspConfigId !== id) {
      await this.sorbetWorkspaceContext.update("selectedLspConfigId", id);
      this.refresh();
    }
  }

  public async setTypedFalseCompletionNudges(enabled: boolean): Promise<void> {
    await this.sorbetWorkspaceContext.update(
      "typedFalseCompletionNudges",
      enabled,
    );
    this.refresh();
  }
}
