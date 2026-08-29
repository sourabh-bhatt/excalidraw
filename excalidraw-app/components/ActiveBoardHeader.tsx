import React from "react";
import { useAtomValue } from "../app-jotai";
import { activeBoardAtom } from "../data/s3Storage";
import { isCollaboratingAtom } from "../collab/Collab";
import "./ActiveBoardHeader.scss";

interface ActiveBoardHeaderProps {
  onClick: () => void;
}

export const ActiveBoardHeader: React.FC<ActiveBoardHeaderProps> = ({ onClick }) => {
  const activeBoard = useAtomValue(activeBoardAtom);
  const isCollaborating = useAtomValue(isCollaboratingAtom);

  const displayName = activeBoard.name || (activeBoard.id ? "Untitled Board" : "Local Canvas");
  const isS3 = !!activeBoard.id;

  return (
    <button
      type="button"
      className="active-board-header"
      onClick={onClick}
      title={`Active Board: ${displayName} (${isS3 ? "AWS S3 Cloud" : "Local"}). Click to switch or manage cloud boards.`}
    >
      <span className="board-icon">
        {isCollaborating ? "⚡" : isS3 ? "☁️" : "📄"}
      </span>
      <span className="board-name">{displayName}</span>
      <span
        className={`board-status ${
          isCollaborating
            ? "status-live"
            : activeBoard.isSaving
            ? "status-saving"
            : isS3
            ? "status-saved"
            : "status-local"
        }`}
      >
        {isCollaborating ? (
          <>
            <span className="live-dot" />
            Live
          </>
        ) : activeBoard.isSaving ? (
          "Saving"
        ) : isS3 ? (
          "Saved"
        ) : (
          "Local"
        )}
      </span>
    </button>
  );
};
