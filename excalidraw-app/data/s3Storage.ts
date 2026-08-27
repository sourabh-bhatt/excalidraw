import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { AppState, BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

const API_BASE = (import.meta.env.VITE_APP_BACKEND_URL || "").replace(/\/$/, "");

export interface S3SceneMetadata {
  id: string;
  name: string;
  lastModified?: string | Date;
  size?: number;
  elementCount?: number;
}

export interface S3SavedScene {
  id: string;
  name: string;
  version: number;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  updatedAt: string;
}

/**
 * Check backend connection and storage mode
 */
export const checkBackendHealth = async (): Promise<{
  status: string;
  storageMode: string;
  bucket: string | null;
  region: string | null;
}> => {
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (!res.ok) throw new Error("Healthcheck failed");
    return await res.json();
  } catch (err: any) {
    return {
      status: "unreachable",
      storageMode: "OFFLINE",
      bucket: null,
      region: null,
    };
  }
};

/**
 * List all saved boards from S3
 */
export const listS3Scenes = async (): Promise<S3SceneMetadata[]> => {
  try {
    const res = await fetch(`${API_BASE}/api/v1/scenes`);
    if (!res.ok) throw new Error(`Failed to list scenes: ${res.statusText}`);
    const data = await res.json();
    return data.scenes || [];
  } catch (err) {
    console.error("[S3Storage] Error listing scenes:", err);
    throw err;
  }
};

/**
 * Save current drawing scene to S3
 */
export const saveSceneToS3 = async ({
  id,
  name,
  elements,
  appState,
  files,
}: {
  id?: string;
  name: string;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
}): Promise<{ id: string }> => {
  const cleanTitle = (name || "Untitled Board").trim();
  const slug = cleanTitle.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^_+|_+$/g, "").substring(0, 32);
  const sceneId = id || (slug ? `${slug}_${Date.now().toString().slice(-4)}` : `board_${Date.now()}`);
  
  const payload: S3SavedScene = {
    id: sceneId,
    name: cleanTitle,
    version: 2,
    elements,
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor,
      gridSize: appState.gridSize,
      gridStep: appState.gridStep,
    },
    files,
    updatedAt: new Date().toISOString(),
  };

  const res = await fetch(`${API_BASE}/api/v1/scenes/${sceneId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to save scene: ${res.statusText}`);
  }

  return { id: sceneId };
};

/**
 * Load a scene by ID from S3
 */
export const loadSceneFromS3 = async (id: string): Promise<S3SavedScene> => {
  const res = await fetch(`${API_BASE}/api/v1/scenes/${id}`);
  if (!res.ok) {
    throw new Error(`Scene not found or failed to load: ${res.statusText}`);
  }
  return await res.json();
};

/**
 * Delete a scene from S3
 */
export const deleteS3Scene = async (id: string): Promise<void> => {
  const res = await fetch(`${API_BASE}/api/v1/scenes/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`Failed to delete scene: ${res.statusText}`);
  }
};

/**
 * Upload binary image file to S3
 */
export const uploadFileToS3 = async (
  fileId: FileId,
  fileData: BinaryFileData,
): Promise<void> => {
  const res = await fetch(`${API_BASE}/api/v1/files/${fileId}`, {
    method: "POST",
    headers: {
      "Content-Type": fileData.mimeType || "application/octet-stream",
    },
    body: fileData.dataURL,
  });

  if (!res.ok) {
    throw new Error(`Failed to upload file to S3: ${res.statusText}`);
  }
};

/**
 * Get binary image file from S3
 */
export const getFileFromS3 = async (fileId: FileId): Promise<string> => {
  const res = await fetch(`${API_BASE}/api/v1/files/${fileId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch file from S3: ${res.statusText}`);
  }
  return await res.text();
};
