import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";
import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

const API_BASE = (import.meta.env.VITE_APP_BACKEND_URL || "").replace(/\/$/, "");

const bufferToBase64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
};

const base64ToUint8Array = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes as Uint8Array<ArrayBuffer>;
};

export interface StoredCollabScene {
  sceneVersion: number;
  iv: string;
  ciphertext: string;
}

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<StoredCollabScene> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return {
    sceneVersion: getSceneVersion(elements),
    ciphertext: bufferToBase64(encryptedBuffer),
    iv: bufferToBase64(iv),
  };
};

const decryptElements = async (
  data: StoredCollabScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = base64ToUint8Array(data.ciphertext);
  const iv = base64ToUint8Array(data.iv);

  const decrypted = await decryptData(iv, ciphertext.buffer as ArrayBuffer, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class FirebaseSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return FirebaseSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    FirebaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return FirebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  return true;
};

export const loadFirebaseStorage = async () => {
  return null as any;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/files/${id}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
          },
          body: new Blob([buffer as any]),
        });
        if (res.ok) {
          savedFiles.push(id);
        } else {
          erroredFiles.push(id);
        }
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  try {
    const encrypted = await encryptElements(roomKey, elements);
    const res = await fetch(`${API_BASE}/api/v1/rooms/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(encrypted),
    });

    if (!res.ok) {
      return null;
    }

    FirebaseSceneVersionCache.set(socket, elements);
    return toBrandedType<RemoteExcalidrawElement[]>(elements as any);
  } catch (error) {
    console.error("Error saving room to backend:", error);
    return null;
  }
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  try {
    const res = await fetch(`${API_BASE}/api/v1/rooms/${roomId}`);
    if (!res.ok) {
      return null;
    }
    const data: StoredCollabScene = await res.json();
    if (!data.ciphertext || !data.iv) {
      return null;
    }
    const rawElements = await decryptElements(data, roomKey);
    const elements = getSyncableElements(
      restoreElements(rawElements, null, {
        deleteInvisibleElements: true,
      }),
    );

    if (socket) {
      FirebaseSceneVersionCache.set(socket, elements);
    }

    return elements;
  } catch (error) {
    console.error("Error loading room from backend:", error);
    return null;
  }
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const url = `${API_BASE}/api/v1/files/${id}`;
        const response = await fetch(url);
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();
          let dataURL: DataURL | null = null;
          let mimeType: any = MIME_TYPES.binary;

          if (decryptionKey) {
            try {
              const { data, metadata } = await decompressData<BinaryFileMetadata>(
                new Uint8Array(arrayBuffer),
                {
                  decryptionKey,
                },
              );

              dataURL = new TextDecoder().decode(data) as DataURL;
              mimeType = metadata.mimeType || MIME_TYPES.binary;
            } catch (decompErr) {
              // May be uncompressed raw dataURL uploaded directly
            }
          }

          if (!dataURL) {
            const text = new TextDecoder().decode(new Uint8Array(arrayBuffer));
            if (text.startsWith("data:")) {
              dataURL = text as DataURL;
              const match = text.match(/^data:([^;]+);/);
              if (match) {
                mimeType = match[1] as any;
              }
            }
          }

          if (dataURL) {
            loadedFiles.push({
              mimeType: (mimeType || MIME_TYPES.binary) as any,
              id,
              dataURL,
              created: Date.now(),
              lastRetrieved: Date.now(),
            });
          } else {
            erroredFiles.set(id, true);
          }
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
