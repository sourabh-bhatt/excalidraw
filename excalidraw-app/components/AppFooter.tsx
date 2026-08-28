import { Footer } from "@excalidraw/excalidraw/index";
import React from "react";

import { isExcalidrawPlusSignedUser } from "../app_constants";
import { useAtomValue } from "../app-jotai";
import { activeBoardAtom } from "../data/s3Storage";

import { DebugFooter, isVisualDebuggerEnabled } from "./DebugCanvas";
import { EncryptedIcon } from "./EncryptedIcon";

export const AppFooter = React.memo(
  ({
    onChange,
    onS3BoardsDialogOpen,
  }: {
    onChange: () => void;
    onS3BoardsDialogOpen?: () => void;
  }) => {
    const activeBoard = useAtomValue(activeBoardAtom);

    return (
      <Footer>
        <div
          style={{
            display: "flex",
            gap: ".5rem",
            alignItems: "center",
          }}
        >
          {isVisualDebuggerEnabled() && <DebugFooter onChange={onChange} />}

          {activeBoard.id && (
            <button
              onClick={onS3BoardsDialogOpen}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.35rem",
                padding: "0.25rem 0.55rem",
                borderRadius: "6px",
                border: "1px solid var(--color-gray-30, #ced4da)",
                background: "var(--island-bg-color, #ffffff)",
                color: "var(--color-primary, #6965db)",
                fontSize: "0.78rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
              title={`Active S3 Board: ${activeBoard.name || activeBoard.id}. Click to manage cloud boards.`}
            >
              <span>☁️</span>
              <span
                style={{
                  maxWidth: "130px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {activeBoard.name || activeBoard.id}
              </span>
              <span
                style={{
                  fontSize: "0.7rem",
                  color: activeBoard.isSaving ? "#e67700" : "#2b8a3e",
                  fontWeight: 500,
                }}
              >
                {activeBoard.isSaving ? "(Saving...)" : "(Saved)"}
              </span>
            </button>
          )}

          {!isExcalidrawPlusSignedUser && <EncryptedIcon />}
        </div>
      </Footer>
    );
  },
);
