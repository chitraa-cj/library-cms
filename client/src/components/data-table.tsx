import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Edit, Trash2, Eye, Plus, Search, AlertCircle } from "lucide-react";
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
              {columns.map((col) => (
                <TableHead key={col.key} className="font-medium text-xs uppercase tracking-wider">
                  {col.label}
                </TableHead>
              ))}
              {(onEdit || onDelete || onView) && (
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
                  {columns.map((col) => (
                    <TableCell key={col.key}>
                      <Skeleton className="h-5 w-full max-w-[200px]" />
                    </TableCell>
                  ))}
                  {(onEdit || onDelete || onView) && (
                    <TableCell>
                      <Skeleton className="h-5 w-20 ml-auto" />
                    </TableCell>
                  )}
                </TableRow>
              ))
            ) : filteredData.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + (onEdit || onDelete || onView ? 1 : 0)}
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
              filteredData.map((item, index) => (
                <TableRow
                  key={item.documentId || item.id || index}
                  className="group hover:bg-muted/20 transition-colors"
                  data-testid={`row-${testIdPrefix}-${item.documentId || index}`}
                >
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
                  {(onEdit || onDelete || onView) && (
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {onView && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => onView(item)}
                            data-testid={`button-view-${testIdPrefix}-${item.documentId || index}`}
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
                            data-testid={`button-edit-${testIdPrefix}-${item.documentId || index}`}
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
                            data-testid={`button-delete-${testIdPrefix}-${item.documentId || index}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))
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
