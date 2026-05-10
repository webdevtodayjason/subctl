// read_attachment + list_attachments tools for the master daemon.
//
// Use case: an attachment was inline-injected during a previous chat turn,
// auto-compaction has since dropped that turn's content from the
// transcript, and the master needs to re-read the attachment to answer
// a follow-up. Without this tool, the master would have to ask the
// operator to re-upload.

import {
  listAttachments,
  readAttachmentContent,
} from "../attachments";

export const attachmentsTools = {
  read_attachment: {
    description:
      "Read the content of a stored attachment by id. Use this when an attachment from a prior chat turn isn't in your current context window (auto-compaction may have dropped it) and the operator references it. The attachment id is shown in transcript metadata after the user uploaded or paste-attached a document. Returns the raw text content plus filename + size + mime.",
    schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Attachment id (8 hex chars, e.g. 'a1b2c3d4'). Find via list_attachments if you don't have it.",
        },
        start: {
          type: "number",
          description: "Optional byte offset to start reading from. Default 0.",
        },
        end: {
          type: "number",
          description: "Optional byte offset to stop reading at (exclusive). Default = end of file. Use start+end together to chunk a large attachment.",
        },
      },
      required: ["id"],
    },
    invoke: async (args: { id: string; start?: number; end?: number }) => {
      const range =
        typeof args.start === "number" || typeof args.end === "number"
          ? { start: args.start, end: args.end }
          : undefined;
      const r = readAttachmentContent(args.id, range);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        id: args.id,
        filename: r.attachment!.filename,
        mime: r.attachment!.mime,
        size_total: r.attachment!.size,
        bytes_returned: r.bytes,
        content: r.content,
      };
    },
  },

  list_attachments: {
    description:
      "List all stored attachments (not deleted). Use to find an attachment id when the operator references a document by name but didn't include the id in the current turn. Returns metadata only — call read_attachment to get content.",
    schema: {
      type: "object",
      properties: {
        filter_filename: {
          type: "string",
          description: "Optional substring to filter filenames by (case-insensitive).",
        },
        limit: {
          type: "number",
          description: "Optional cap on number of results. Default 50.",
        },
      },
      required: [],
    },
    invoke: async (args: { filter_filename?: string; limit?: number }) => {
      const limit = Math.max(1, Math.min(500, args.limit ?? 50));
      const filter = (args.filter_filename ?? "").trim().toLowerCase();
      const all = listAttachments();
      const filtered = filter
        ? all.filter((a) => a.filename.toLowerCase().includes(filter))
        : all;
      // Newest first
      filtered.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const out = filtered.slice(0, limit).map((a) => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
        mime: a.mime,
        source: a.source,
        created_at: a.created_at,
      }));
      return {
        ok: true,
        count: out.length,
        total: filtered.length,
        attachments: out,
      };
    },
  },
};
