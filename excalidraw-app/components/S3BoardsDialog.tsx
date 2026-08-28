import React, { useEffect, useState } from "react";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import {
  listS3Scenes,
  saveSceneToS3,
  loadSceneFromS3,
  deleteS3Scene,
  checkBackendHealth,
  getBoardUrl,
  activeBoardAtom,
  type S3SceneMetadata,
} from "../data/s3Storage";
import { useAtom } from "../app-jotai";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "./S3BoardsDialog.scss";

interface S3BoardsDialogProps {
  onClose: () => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  onStartCollab?: () => void;
}

export const S3BoardsDialog: React.FC<S3BoardsDialogProps> = ({
  onClose,
  excalidrawAPI,
  onStartCollab,
}) => {
  const [activeBoard, setActiveBoard] = useAtom(activeBoardAtom);
  const [boardName, setBoardName] = useState(activeBoard.name || "");
  const [scenes, setScenes] = useState<S3SceneMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusInfo, setStatusInfo] = useState<{
    storageMode: string;
    bucket: string | null;
    region: string | null;
  } | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const refreshList = async () => {
    setLoading(true);
    try {
      const [health, items] = await Promise.all([
        checkBackendHealth(),
        listS3Scenes().catch(() => []),
      ]);
      setStatusInfo(health);
      setScenes(
        items.sort((a, b) => {
          const timeA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
          const timeB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
          return timeB - timeA;
        }),
      );
    } catch (err: any) {
      setMessage({ type: "error", text: "Failed to connect to storage backend" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshList();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!excalidrawAPI) return;

    const name = boardName.trim() || `Board ${new Date().toLocaleDateString()}`;
    setSaving(true);
    setMessage(null);

    try {
      const elements = excalidrawAPI.getSceneElements();
      const appState = excalidrawAPI.getAppState();
      const files = excalidrawAPI.getFiles();

      const result = await saveSceneToS3({
        id: activeBoard.id || undefined,
        name,
        elements,
        appState,
        files,
        collabRoomId: activeBoard.collabRoomId,
        collabRoomKey: activeBoard.collabRoomKey,
        lastCollabAt: activeBoard.lastCollabAt,
      });

      setActiveBoard({
        id: result.id,
        name,
        lastSavedAt: Date.now(),
        isSaving: false,
        collabRoomId: activeBoard.collabRoomId,
        collabRoomKey: activeBoard.collabRoomKey,
        lastCollabAt: activeBoard.lastCollabAt,
      });

      const newUrl = getBoardUrl(result.id, activeBoard.collabRoomId && activeBoard.collabRoomKey ? {
        roomId: activeBoard.collabRoomId,
        roomKey: activeBoard.collabRoomKey,
      } : null);
      window.history.pushState({}, name, newUrl);
      document.title = `${name} - Excalidraw`;

      setMessage({ type: "success", text: `Successfully saved "${name}" to S3!` });
      await refreshList();
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to save to S3" });
    } finally {
      setSaving(false);
    }
  };

  const handleLoad = async (scene: S3SceneMetadata) => {
    if (!excalidrawAPI) return;
    setLoading(true);
    setMessage(null);

    try {
      const sceneData = await loadSceneFromS3(scene.id);
      excalidrawAPI.updateScene({
        elements: sceneData.elements,
        appState: {
          viewBackgroundColor: sceneData.appState?.viewBackgroundColor || "#ffffff",
        },
      });

      if (sceneData.files) {
        excalidrawAPI.addFiles(Object.values(sceneData.files));
      }

      setActiveBoard({
        id: scene.id,
        name: sceneData.name || scene.id,
        lastSavedAt: Date.now(),
        isSaving: false,
        collabRoomId: sceneData.collabRoomId || scene.collabRoomId,
        collabRoomKey: sceneData.collabRoomKey || scene.collabRoomKey,
        lastCollabAt: sceneData.lastCollabAt || scene.lastCollabAt,
      });

      const newUrl = getBoardUrl(scene.id);
      window.history.pushState({}, sceneData.name || scene.id, newUrl);
      document.title = `${sceneData.name || scene.id} - Excalidraw`;

      setMessage({ type: "success", text: `Loaded board "${sceneData.name || scene.id}"!` });
      setTimeout(() => {
        onClose();
      }, 500);
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to load board" });
    } finally {
      setLoading(false);
    }
  };

  const handleJoinLive = async (scene: S3SceneMetadata) => {
    if (!scene.collabRoomId || !scene.collabRoomKey) {
      // If no room exists yet, open board and start collab
      await handleLoad(scene);
      onClose();
      onStartCollab?.();
      return;
    }

    const liveUrl = getBoardUrl(scene.id, {
      roomId: scene.collabRoomId,
      roomKey: scene.collabRoomKey,
    });
    window.location.href = liveUrl;
    window.location.reload();
  };

  const handleCopyBoardUrl = (scene: S3SceneMetadata, e: React.MouseEvent) => {
    e.stopPropagation();
    const url = getBoardUrl(scene.id);
    navigator.clipboard.writeText(url);
    setMessage({ type: "info", text: `📋 Board URL copied: ${url}` });
  };

  const handleCopyLiveUrl = (scene: S3SceneMetadata, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!scene.collabRoomId || !scene.collabRoomKey) return;
    const url = getBoardUrl(scene.id, {
      roomId: scene.collabRoomId,
      roomKey: scene.collabRoomKey,
    });
    navigator.clipboard.writeText(url);
    setMessage({ type: "info", text: `🔗 Live Collab link copied: ${url}` });
  };

  const handleNewBoard = () => {
    if (!excalidrawAPI) return;
    if (
      excalidrawAPI.getSceneElements().length > 0 &&
      !window.confirm("Start a new blank board? Unsaved local changes will be cleared.")
    ) {
      return;
    }

    const newId = `board_${Date.now()}`;
    excalidrawAPI.resetScene();
    setActiveBoard({
      id: newId,
      name: "Untitled Board",
      lastSavedAt: null,
      isSaving: false,
    });

    const newUrl = getBoardUrl(newId);
    window.history.pushState({}, "Untitled Board", newUrl);
    document.title = `Untitled Board - Excalidraw`;
    setBoardName("Untitled Board");
    setMessage({ type: "info", text: "Created new blank board! Type a name and save to S3." });
  };

  const handleDelete = async (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Are you sure you want to delete "${name || id}" from S3?`)) {
      return;
    }

    try {
      await deleteS3Scene(id);
      setScenes((prev) => prev.filter((s) => s.id !== id));
      if (activeBoard.id === id) {
        setActiveBoard({ id: null, name: null, lastSavedAt: null, isSaving: false });
        window.history.pushState({}, "Excalidraw", window.location.origin + window.location.pathname);
      }
      setMessage({ type: "success", text: `Deleted "${name || id}"` });
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to delete board" });
    }
  };

  const filteredScenes = scenes.filter((s) =>
    (s.name || s.id).toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <Dialog
      onCloseRequest={onClose}
      title="Cloud Boards (AWS S3 Database)"
      className="s3-boards-dialog"
      size="wide"
    >
      <div className="s3-dialog-content">
        {/* Storage Badge Header */}
        <div className="s3-status-bar">
          <div className="s3-status-indicator">
            <span
              className={`status-dot ${
                statusInfo?.storageMode === "AWS_S3" ? "online" : "fallback"
              }`}
            />
            <span className="status-text">
              {statusInfo?.storageMode === "AWS_S3"
                ? `AWS S3: ${statusInfo.bucket} (${statusInfo.region})`
                : statusInfo?.storageMode === "LOCAL_FALLBACK"
                ? "Storage: Local Dev Fallback (Configure AWS S3 in .env for Cloud)"
                : "Storage Backend Offline"}
            </span>
          </div>
          <div className="s3-header-actions">
            <button className="s3-btn-small" onClick={handleNewBoard} title="Start new board">
              ➕ New Board
            </button>
            <button className="s3-refresh-btn" onClick={refreshList} disabled={loading}>
              🔄 Refresh
            </button>
          </div>
        </div>

        {activeBoard.id && (
          <div className="s3-active-board-banner">
            <span className="banner-icon">📌</span>
            <span className="banner-text">
              Active Board: <strong>{activeBoard.name || activeBoard.id}</strong>
              {activeBoard.isSaving ? " (Saving to S3...)" : " (Auto-saves to S3)"}
            </span>
            <button
              className="s3-btn-link"
              onClick={(e) => handleCopyBoardUrl({ id: activeBoard.id!, name: activeBoard.name || activeBoard.id! }, e)}
            >
              📋 Copy Board URL
            </button>
          </div>
        )}

        {message && (
          <div className={`s3-alert s3-alert-${message.type}`}>
            {message.text}
          </div>
        )}

        {/* Save Current Board Section */}
        <div className="s3-save-section">
          <h3>💾 Save Canvas to Cloud</h3>
          <form onSubmit={handleSave} className="s3-save-form">
            <input
              type="text"
              placeholder="Enter board title (e.g. System Architecture Diagram)"
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
              className="s3-input"
            />
            <button type="submit" className="s3-btn s3-btn-primary" disabled={saving}>
              {saving ? "Saving..." : activeBoard.id ? "Update S3 Board" : "Save to Cloud"}
            </button>
          </form>
        </div>

        <hr className="s3-divider" />

        {/* Browse Boards Section */}
        <div className="s3-list-section">
          <div className="s3-list-header">
            <h3>📂 Your Cloud Boards ({scenes.length})</h3>
            {scenes.length > 3 && (
              <input
                type="text"
                placeholder="Search boards..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="s3-search-input"
              />
            )}
          </div>

          {loading && scenes.length === 0 ? (
            <div className="s3-loading-state">Loading cloud boards...</div>
          ) : filteredScenes.length === 0 ? (
            <div className="s3-empty-state">
              {searchQuery
                ? "No boards match your search."
                : "No saved boards yet. Use the form above to save your first canvas to S3!"}
            </div>
          ) : (
            <div className="s3-boards-grid">
              {filteredScenes.map((scene) => {
                const isActive = activeBoard.id === scene.id;
                const hasCollab = !!(scene.collabRoomId || scene.lastCollabAt);

                return (
                  <div
                    key={scene.id}
                    className={`s3-board-card ${isActive ? "active-board-card" : ""}`}
                  >
                    <div className="s3-card-info">
                      <div className="s3-title-row">
                        <h4 className="s3-card-title">{scene.name || scene.id}</h4>
                        {isActive && <span className="s3-badge-active">Active</span>}
                      </div>

                      <div className="s3-card-meta">
                        <span>
                          {scene.lastModified
                            ? `Modified: ${new Date(scene.lastModified).toLocaleString()}`
                            : "Saved"}
                          {scene.size ? ` • ${(scene.size / 1024).toFixed(1)} KB` : ""}
                        </span>
                      </div>

                      {hasCollab && (
                        <div className="s3-collab-meta">
                          <span className="live-badge">
                            <span className="live-dot" />
                            Live Session
                          </span>
                          {scene.lastCollabAt && (
                            <span className="live-date">
                              {new Date(scene.lastCollabAt).toLocaleString([], {
                                dateStyle: "short",
                                timeStyle: "short",
                              })}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="s3-card-actions">
                      {hasCollab && scene.collabRoomId && (
                        <button
                          className="s3-btn s3-btn-collab"
                          onClick={() => handleJoinLive(scene)}
                          title="Join Live Collaboration Session"
                        >
                          ⚡ Join Live
                        </button>
                      )}

                      <button
                        className="s3-btn s3-btn-secondary"
                        onClick={() => handleLoad(scene)}
                        disabled={loading}
                        title="Load into Canvas"
                      >
                        Open
                      </button>

                      <button
                        className="s3-btn s3-btn-icon"
                        onClick={(e) => handleCopyBoardUrl(scene, e)}
                        title="Copy Board URL"
                      >
                        📋
                      </button>

                      {hasCollab && scene.collabRoomId && (
                        <button
                          className="s3-btn s3-btn-icon"
                          onClick={(e) => handleCopyLiveUrl(scene, e)}
                          title="Copy Live Collab URL"
                        >
                          🔗
                        </button>
                      )}

                      <button
                        className="s3-btn s3-btn-danger"
                        onClick={(e) => handleDelete(scene.id, scene.name, e)}
                        title="Delete from S3"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
};
