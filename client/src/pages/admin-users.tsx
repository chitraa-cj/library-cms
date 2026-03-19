import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { UserPlus, Trash2, KeyRound, ShieldCheck, User, Loader2 } from "lucide-react";

type SafeUser = {
  id: string;
  username: string;
  displayName: string | null;
  role: string | null;
  createdAt: string | null;
};

export default function AdminUsersPage() {
  const { user: me } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState<SafeUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SafeUser | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"editor" | "admin">("editor");

  const [resetPassword, setResetPassword] = useState("");

  if (me?.role !== "admin") {
    setLocation("/dashboard");
    return null;
  }

  const { data: users = [], isLoading } = useQuery<SafeUser[]>({
    queryKey: ["/api/admin/users"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { username: string; displayName: string; password: string; role: string }) => {
      const res = await apiRequest("POST", "/api/admin/users", data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to create user");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "User created", description: `Account "${newUsername}" is ready.` });
      setCreateOpen(false);
      setNewUsername(""); setNewDisplayName(""); setNewPassword(""); setNewRole("editor");
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const roleMutation = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: string }) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${id}/role`, { role });
      if (!res.ok) { const e = await res.json(); throw new Error(e.message); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Role updated" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const passwordMutation = useMutation({
    mutationFn: async ({ id, password }: { id: string; password: string }) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${id}/password`, { password });
      if (!res.ok) { const e = await res.json(); throw new Error(e.message); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Password reset", description: "Password has been updated." });
      setResetOpen(null);
      setResetPassword("");
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/admin/users/${id}`);
      if (!res.ok) { const e = await res.json(); throw new Error(e.message); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "User deleted" });
      setDeleteTarget(null);
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">User Management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Create and manage accounts for data entry staff. Multiple users can work on different mantras simultaneously.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} data-testid="button-create-user">
          <UserPlus className="w-4 h-4 mr-2" />
          Add User
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="border rounded-xl overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Username</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id} data-testid={`row-user-${u.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium text-primary shrink-0">
                        {(u.displayName || u.username).charAt(0).toUpperCase()}
                      </div>
                      <span className="font-medium">{u.displayName || u.username}</span>
                      {u.id === me?.id && (
                        <Badge variant="outline" className="text-[10px]">You</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-sm">{u.username}</TableCell>
                  <TableCell>
                    <Select
                      value={u.role ?? "editor"}
                      onValueChange={(role) => roleMutation.mutate({ id: u.id, role })}
                      disabled={u.id === me?.id}
                    >
                      <SelectTrigger className="h-7 w-24 text-xs" data-testid={`select-role-${u.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="editor">
                          <span className="flex items-center gap-1.5">
                            <User className="w-3 h-3" /> Editor
                          </span>
                        </SelectItem>
                        <SelectItem value="admin">
                          <span className="flex items-center gap-1.5">
                            <ShieldCheck className="w-3 h-3" /> Admin
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="icon" variant="ghost"
                        className="h-7 w-7"
                        title="Reset password"
                        onClick={() => { setResetOpen(u); setResetPassword(""); }}
                        data-testid={`button-reset-password-${u.id}`}
                      >
                        <KeyRound className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        size="icon" variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        title="Delete user"
                        disabled={u.id === me?.id}
                        onClick={() => setDeleteTarget(u)}
                        data-testid={`button-delete-user-${u.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {users.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-10">
                    No users found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mt-6 p-4 rounded-xl border bg-muted/30">
        <h3 className="text-sm font-semibold mb-1">How multi-user data entry works</h3>
        <p className="text-xs text-muted-foreground">
          Each team member gets their own account. They can log in simultaneously and work on different mantras — since every mantra is an independent record, there are no conflicts. Assign sections to team members verbally and each person edits their own set of mantras. Admins can manage Grantha structure; editors focus on entering mantra text.
        </p>
      </div>

      {/* Create user dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Username</Label>
              <Input
                value={newUsername} onChange={(e) => setNewUsername(e.target.value)}
                placeholder="e.g. ravi_editor"
                data-testid="input-new-username"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Display Name</Label>
              <Input
                value={newDisplayName} onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder="e.g. Ravi Kumar"
                data-testid="input-new-display-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Password</Label>
              <Input
                type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min 6 characters"
                data-testid="input-new-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as "editor" | "admin")}>
                <SelectTrigger data-testid="select-new-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="editor">Editor — can enter and publish mantra data</SelectItem>
                  <SelectItem value="admin">Admin — full access including user management</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={() => createMutation.mutate({ username: newUsername, displayName: newDisplayName, password: newPassword, role: newRole })}
              disabled={createMutation.isPending || !newUsername || !newPassword}
              data-testid="button-confirm-create-user"
            >
              {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset password dialog */}
      <Dialog open={!!resetOpen} onOpenChange={(o) => { if (!o) setResetOpen(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Password — {resetOpen?.displayName || resetOpen?.username}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label>New Password</Label>
            <Input
              type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)}
              placeholder="Min 6 characters"
              data-testid="input-reset-password"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResetOpen(null)}>Cancel</Button>
            <Button
              onClick={() => resetOpen && passwordMutation.mutate({ id: resetOpen.id, password: resetPassword })}
              disabled={passwordMutation.isPending || resetPassword.length < 6}
              data-testid="button-confirm-reset-password"
            >
              {passwordMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Reset Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.displayName || deleteTarget?.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the account. Their saved drafts will remain in the system.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              data-testid="button-confirm-delete-user"
            >
              {deleteMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
