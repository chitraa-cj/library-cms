import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Bold,
  Italic,
  UnderlineIcon,
  Strikethrough,
  List,
  ListOrdered,
  RemoveFormatting,
} from "lucide-react";
import type { StrapiBlock } from "@shared/schema";
import { blocksToTipTap, tipTapToBlocks } from "@/lib/strapi-blocks";

interface RichTextEditorProps {
  value: StrapiBlock[] | string | null | undefined;
  onChange: (value: StrapiBlock[]) => void;
  placeholder?: string;
  className?: string;
  minHeight?: number;
  "data-testid"?: string;
}

export default function RichTextEditor({
  value,
  onChange,
  placeholder = "Enter text...",
  className,
  minHeight = 120,
  "data-testid": testId,
}: RichTextEditorProps) {
  // Prevents the useEffect from calling setContent after the editor
  // itself triggered an onChange (which would reset the cursor / lose pasted text).
  const suppressNextEffect = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // StarterKit includes strike; make sure it doesn't duplicate underline
      }),
      Underline,
      Placeholder.configure({
        placeholder,
        emptyEditorClass:
          "before:content-[attr(data-placeholder)] before:text-muted-foreground before:float-left before:h-0 before:pointer-events-none",
      }),
    ],
    content: blocksToTipTap(value),
    onUpdate({ editor }) {
      suppressNextEffect.current = true;
      onChange(tipTapToBlocks(editor.getJSON() as any));
    },
  });

  useEffect(() => {
    if (!editor) return;
    // Skip if this update was triggered by the editor itself (avoids paste/typing reset)
    if (suppressNextEffect.current) {
      suppressNextEffect.current = false;
      return;
    }
    // Safety guard: never interrupt while the user is actively editing
    if (editor.isFocused) return;
    const incoming = blocksToTipTap(value);
    editor.commands.setContent(incoming, false);
  }, [value]);

  if (!editor) return null;

  const ToolBtn = ({
    active,
    onClick,
    title,
    children,
  }: {
    active?: boolean;
    onClick: () => void;
    title: string;
    children: React.ReactNode;
  }) => (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={cn(
        "h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
        active && "bg-muted text-foreground"
      )}
    >
      {children}
    </button>
  );

  return (
    <div
      className={cn(
        "rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden",
        className
      )}
      data-testid={testId}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-input bg-muted/30">
        <ToolBtn
          title="Bold"
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold className="w-3.5 h-3.5" />
        </ToolBtn>
        <ToolBtn
          title="Italic"
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic className="w-3.5 h-3.5" />
        </ToolBtn>
        <ToolBtn
          title="Underline"
          active={editor.isActive("underline")}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <UnderlineIcon className="w-3.5 h-3.5" />
        </ToolBtn>
        <ToolBtn
          title="Strikethrough"
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough className="w-3.5 h-3.5" />
        </ToolBtn>
        <div className="w-px h-4 bg-border mx-1" />
        <ToolBtn
          title="Bullet list"
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List className="w-3.5 h-3.5" />
        </ToolBtn>
        <ToolBtn
          title="Numbered list"
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="w-3.5 h-3.5" />
        </ToolBtn>
        <div className="w-px h-4 bg-border mx-1" />
        <ToolBtn
          title="Clear formatting"
          active={false}
          onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
        >
          <RemoveFormatting className="w-3.5 h-3.5" />
        </ToolBtn>
      </div>
      {/* Editor area */}
      <EditorContent
        editor={editor}
        className={cn("rich-text-editor-content px-3 py-2 text-sm focus:outline-none")}
        style={{ minHeight }}
      />
    </div>
  );
}
