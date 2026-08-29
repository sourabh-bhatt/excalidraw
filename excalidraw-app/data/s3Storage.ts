import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { AppState, BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

const API_BASE = (import.meta.env.VITE_APP_BACKEND_URL || "").replace(/\/$/, "");

import { atom } from "../app-jotai";

export interface S3SceneMetadata {
  id: string;
  name: string;
  lastModified?: string | Date;
  size?: number;
  elementCount?: number;
  collabRoomId?: string | null;
  collabRoomKey?: string | null;
  lastCollabAt?: string | null;
}

export interface S3SavedScene {
  id: string;
  name: string;
  version: number;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  updatedAt: string;
  collabRoomId?: string | null;
  collabRoomKey?: string | null;
  lastCollabAt?: string | null;
}

export interface ActiveBoardInfo {
  id: string | null;
  name: string | null;
  lastSavedAt: number | null;
  isSaving: boolean;
  collabRoomId?: string | null;
  collabRoomKey?: string | null;
  lastCollabAt?: string | null;
}

export const activeBoardAtom = atom<ActiveBoardInfo>({
  id: null,
  name: null,
  lastSavedAt: null,
  isSaving: false,
});

/**
 * Generate full URL for a board (and optional live collaboration room)
 */
export const getBoardUrl = (
  boardId: string,
  collabData?: { roomId: string; roomKey: string } | null,
): string => {
  const origin = window.location.origin;
  const pathname = window.location.pathname;
  let url = `${origin}${pathname}?board=${encodeURIComponent(boardId)}`;
  if (collabData?.roomId && collabData?.roomKey) {
    url += `#room=${collabData.roomId},${collabData.roomKey}`;
  }
  return url;
};

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
 * Generate a clean, sensible slug-based ID from a board name
 */
export const generateBoardSlugId = (name: string): string => {
  const cleanTitle = (name || "untitled").trim().toLowerCase();
  const slug = cleanTitle
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .substring(0, 24);
  const randSuffix = Date.now().toString().slice(-6);
  return slug ? `${slug}_${randSuffix}` : `board_${Date.now()}`;
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
  collabRoomId,
  collabRoomKey,
  lastCollabAt,
}: {
  id?: string;
  name: string;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  collabRoomId?: string | null;
  collabRoomKey?: string | null;
  lastCollabAt?: string | null;
}): Promise<{ id: string }> => {
  const cleanTitle = (name || "Untitled Board").trim();
  const sceneId = id || generateBoardSlugId(cleanTitle);
  
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
    collabRoomId: collabRoomId || null,
    collabRoomKey: collabRoomKey || null,
    lastCollabAt: lastCollabAt || null,
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
 * Record a live collaboration session against a saved board
 */
export const linkCollabToS3Scene = async (
  boardId: string,
  roomId: string,
  roomKey: string,
): Promise<{ lastCollabAt: string }> => {
  const res = await fetch(`${API_BASE}/api/v1/scenes/${encodeURIComponent(boardId)}/collab`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, roomKey }),
  });

  if (!res.ok) {
    throw new Error(`Failed to link collab to scene: ${res.statusText}`);
  }

  return await res.json();
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
