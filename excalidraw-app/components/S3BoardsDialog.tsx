import React, { useEffect, useState } from "react";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import {
  listS3Scenes,
  saveSceneToS3,
  loadSceneFromS3,
  deleteS3Scene,
  checkBackendHealth,
  type S3SceneMetadata,
} from "../data/s3Storage";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "./S3BoardsDialog.scss";

interface S3BoardsDialogProps {
  onClose: () => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}

export const S3BoardsDialog: React.FC<S3BoardsDialogProps> = ({
  onClose,
  excalidrawAPI,
}) => {
  const [boardName, setBoardName] = useState("");
  const [scenes, setScenes] = useState<S3SceneMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusInfo, setStatusInfo] = useState<{
    storageMode: string;
    bucket: string | null;
    region: string | null;
  } | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const refreshList = async () => {
    setLoading(true);
    try {
      const [health, items] = await Promise.all([
        checkBackendHealth(),
        listS3Scenes().catch(() => []),
      ]);
      setStatusInfo(health);
      setScenes(items.sort((a, b) => {
        const timeA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
        const timeB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
        return timeB - timeA;
      }));
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
        name,
        elements,
        appState,
        files,
      });

      setMessage({ type: "success", text: `Successfully saved "${name}" to S3!` });
      setBoardName("");
      await refreshList();
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to save to S3" });
    } finally {
      setSaving(false);
    }
  };

  const handleLoad = async (id: string) => {
    if (!excalidrawAPI) return;
    setLoading(true);
    setMessage(null);

    try {
      const sceneData = await loadSceneFromS3(id);
      excalidrawAPI.updateScene({
        elements: sceneData.elements,
        appState: {
          viewBackgroundColor: sceneData.appState?.viewBackgroundColor || "#ffffff",
        },
      });

      if (sceneData.files) {
        excalidrawAPI.addFiles(Object.values(sceneData.files));
      }

      setMessage({ type: "success", text: `Loaded board "${sceneData.name || id}"!` });
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to load board" });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Are you sure you want to delete "${name || id}" from S3?`)) {
      return;
    }

    try {
      await deleteS3Scene(id);
      setScenes((prev) => prev.filter((s) => s.id !== id));
      setMessage({ type: "success", text: `Deleted "${name || id}"` });
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Failed to delete board" });
    }
  };

  const filteredScenes = scenes.filter((s) =>
    (s.name || s.id).toLowerCase().includes(searchQuery.toLowerCase())
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
          <button className="s3-refresh-btn" onClick={refreshList} disabled={loading}>
            🔄 Refresh
          </button>
        </div>

        {message && (
          <div className={`s3-alert s3-alert-${message.type}`}>
            {message.text}
          </div>
        )}

        {/* Save Current Board Section */}
        <div className="s3-save-section">
          <h3>💾 Save Current Canvas to Cloud</h3>
          <form onSubmit={handleSave} className="s3-save-form">
            <input
              type="text"
              placeholder="Enter board title (e.g. System Architecture Diagram)"
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
              className="s3-input"
            />
            <button type="submit" className="s3-btn s3-btn-primary" disabled={saving}>
              {saving ? "Saving..." : "Save to Cloud"}
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
              {filteredScenes.map((scene) => (
                <div key={scene.id} className="s3-board-card">
                  <div className="s3-card-info">
                    <h4 className="s3-card-title">{scene.name || scene.id}</h4>
                    <span className="s3-card-meta">
                      {scene.lastModified
                        ? `Modified: ${new Date(scene.lastModified).toLocaleString()}`
                        : "Saved"}
                      {scene.size ? ` • ${(scene.size / 1024).toFixed(1)} KB` : ""}
                    </span>
                  </div>
                  <div className="s3-card-actions">
                    <button
                      className="s3-btn s3-btn-secondary"
                      onClick={() => handleLoad(scene.id)}
                      disabled={loading}
                      title="Load into Canvas"
                    >
                      Open
                    </button>
                    <button
                      className="s3-btn s3-btn-danger"
                      onClick={() => handleDelete(scene.id, scene.name)}
                      title="Delete from S3"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
};
