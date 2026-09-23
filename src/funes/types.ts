export type ImportTarget = {
    filename: string;
    url?: string;
    contents?: File;
    handle?: FileSystemFileHandle;
    lodManifestPath?: string;
    lodPreviewLevel?: number;
    signal?: AbortSignal;
    animationFrame?: boolean;
};

export type LoadState = {
    state: 'loading' | 'ready' | 'error';
    error?: string;
    preview?: boolean;
    requestId?: string;
    level?: number;
    pointCount?: number;
    lodLevels?: number;
    lodEnvironment?: boolean;
};
