export interface TaskListItem {
  id: string;
  sessionId: string;
  title: string;
  displayTitle: string;
  sessionTitle: string;
  status: string;
  turnCount: number;
  updatedAt: string;
}

export interface TaskListPage {
  tasks: TaskListItem[];
  totalCount: number;
  page: number;
  totalPages: number;
  pageSize: number;
}
