import { type Static, Type } from "typebox";
declare const InstallationSchema: Type.TObject<{
    id: Type.TString;
    components: Type.TRecord<"^.*$", Type.TObject<{
        selector: Type.TString;
        version: Type.TString;
        directory: Type.TString;
    }>>;
    binDirectories: Type.TArray<Type.TString>;
    environment: Type.TRecord<"^.*$", Type.TString>;
}>;
declare const RequestSchema: Type.TObject<{
    id: Type.TString;
    requirements: Type.TRecord<"^.*$", Type.TString>;
}>;
export type ToolRequest = Static<typeof RequestSchema>;
declare const NpmPackageSchema: Type.TObject<{
    name: Type.TString;
    version: Type.TString;
    peerDependencies: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
    engines: Type.TOptional<Type.TObject<{
        node: Type.TOptional<Type.TString>;
    }>>;
}>;
export type NpmPackage = Static<typeof NpmPackageSchema>;
export type ManagedInstallation = Static<typeof InstallationSchema>;
export interface InstallationOptions {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}
/** A private per-user store. Construction and installed() never acquire tools. */
export declare class ToolInstaller {
    readonly directory: string;
    constructor(directory: string);
    installed(id: string): Promise<ManagedInstallation | undefined>;
    /** Network metadata for acquisition/update; compatibility policy remains with callers. */
    npmVersions(name: string, options: InstallationOptions): Promise<(NpmPackage & {
        latest: boolean;
    })[]>;
    list(): Promise<ManagedInstallation[]>;
    private selection;
    ensure(request: ToolRequest, options: InstallationOptions & {
        allowDownload: boolean;
    }): Promise<ManagedInstallation>;
    private reuse;
    update(request: ToolRequest, options: InstallationOptions): Promise<{
        previous: ManagedInstallation;
        current: ManagedInstallation;
    } | undefined>;
    private withInstallationLock;
    private environment;
    private helper;
    private run;
    private concreteTool;
    private acquire;
    private publish;
}
export {};
