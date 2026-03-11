import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Edit, Trash2, Eye, Plus, Search, AlertCircle, Send } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";

interface Column {
  key: string;
  label: string;
  render?: (value: any, row: any) => React.ReactNode;
}

interface DataTableProps {
  title: string;
  description?: string;
  columns: Column[];
  data: any[];
  isLoading: boolean;
  error?: Error | null;
  onAdd?: () => void;
  onEdit?: (item: any) => void;
  onDelete?: (item: any) => void;
  onView?: (item: any) => void;
  onPublish?: (item: any) => void;
  publishingId?: number | null;
  addLabel?: string;
  testIdPrefix: string;
  emptyMessage?: string;
  searchable?: boolean;
  searchKey?: string;
}

export default function DataTable({
  title,
  description,
  columns,
  data,
  isLoading,
  error,
  onAdd,
  onEdit,
  onDelete,
  onView,
  onPublish,
  publishingId,
  addLabel = "Add New",
  testIdPrefix,
  emptyMessage = "No entries found",
  searchable = true,
  searchKey,
}: DataTableProps) {
  const [search, setSearch] = useState("");

  const filteredData = searchable && searchKey
    ? data.filter((item) => {
        const val = item[searchKey];
        return val
          ? String(val).toLowerCase().includes(search.toLowerCase())
          : true;
      })
    : data;

  const hasActions = onEdit || onDelete || onView || onPublish;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid={`text-${testIdPrefix}-title`}>
            {title}
          </h1>
          {description && (
            <p className="text-sm text-muted-foreground mt-1">
              {description}
            </p>
          )}
        </div>
        {onAdd && (
          <Button onClick={onAdd} data-testid={`button-${testIdPrefix}-add`}>
            <Plus className="w-4 h-4 mr-2" />
            {addLabel}
          </Button>
        )}
      </div>

      {searchable && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder={`Search ${title.toLowerCase()}...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid={`input-${testIdPrefix}-search`}
          />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-destructive/10 text-destructive border border-destructive/20">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <div>
            <p className="font-medium text-sm">Error loading data</p>
            <p className="text-xs mt-0.5 opacity-80">{error.message}</p>
          </div>
        </div>
      )}

      <div className="border border-border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="font-medium text-xs uppercase tracking-wider w-[100px]">
                Status
              </TableHead>
              {columns.map((col) => (
                <TableHead key={col.key} className="font-medium text-xs uppercase tracking-wider">
                  {col.label}
                </TableHead>
              ))}
              {hasActions && (
                <TableHead className="text-right font-medium text-xs uppercase tracking-wider">
                  Actions
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                  {columns.map((col) => (
                    <TableCell key={col.key}>
                      <Skeleton className="h-5 w-full max-w-[200px]" />
                    </TableCell>
                  ))}
                  {hasActions && (
                    <TableCell>
                      <Skeleton className="h-5 w-20 ml-auto" />
                    </TableCell>
                  )}
                </TableRow>
              ))
            ) : filteredData.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + (hasActions ? 1 : 0) + 1}
                  className="text-center py-12"
                >
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                      <Search className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {emptyMessage}
                    </p>
                    {onAdd && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={onAdd}
                        className="mt-2"
                      >
                        <Plus className="w-3 h-3 mr-1" />
                        {addLabel}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filteredData.map((item, index) => {
                const isDraft = !!item._isDraft;
                const isPublished = item._draftStatus === "published";
                const rowKey = isDraft ? `draft-${item._draftId}` : (item.documentId || item.id || index);

                return (
                  <TableRow
                    key={rowKey}
                    className={`group hover:bg-muted/20 transition-colors ${isDraft && !isPublished ? "bg-amber-50/50 dark:bg-amber-950/10" : ""}`}
                    data-testid={`row-${testIdPrefix}-${rowKey}`}
                  >
                    <TableCell>
                      {isDraft && !isPublished ? (
                        <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700" data-testid={`badge-status-draft-${rowKey}`}>
                          Draft
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-green-100 text-green-800 border-green-300 dark:bg-green-900/30 dark:text-green-400 dark:border-green-700" data-testid={`badge-status-published-${rowKey}`}>
                          Published
                        </Badge>
                      )}
                    </TableCell>
                    {columns.map((col) => (
                      <TableCell key={col.key} className="text-sm">
                        {col.render
                          ? col.render(item[col.key], item)
                          : item[col.key] || (
                              <span className="text-muted-foreground italic">
                                —
                              </span>
                            )}
                      </TableCell>
                    ))}
                    {hasActions && (
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {onPublish && isDraft && !isPublished && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 text-green-700 hover:text-green-800 hover:bg-green-100 dark:text-green-400 dark:hover:bg-green-900/30"
                              onClick={() => onPublish(item)}
                              disabled={publishingId === item._draftId}
                              data-testid={`button-publish-${testIdPrefix}-${rowKey}`}
                            >
                              <Send className="w-3.5 h-3.5 mr-1" />
                              Publish
                            </Button>
                          )}
                          {onView && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => onView(item)}
                              data-testid={`button-view-${testIdPrefix}-${rowKey}`}
                            >
                              <Eye className="w-4 h-4" />
                            </Button>
                          )}
                          {onEdit && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => onEdit(item)}
                              data-testid={`button-edit-${testIdPrefix}-${rowKey}`}
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                          )}
                          {onDelete && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => onDelete(item)}
                              data-testid={`button-delete-${testIdPrefix}-${rowKey}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {!isLoading && filteredData.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Showing {filteredData.length} of {data.length} entries
        </p>
      )}
    </div>
  );
}
