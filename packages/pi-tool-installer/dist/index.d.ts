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
    private selection;
    ensure(request: ToolRequest, options: InstallationOptions & {
        allowDownload: boolean;
    }): Promise<ManagedInstallation>;
    update(request: ToolRequest, options: InstallationOptions): Promise<{
        previous: ManagedInstallation;
        current: ManagedInstallation;
    } | undefined>;
    private withInstallationLock;
    private environment;
    private helper;
    private run;
    private acquire;
}
export {};
