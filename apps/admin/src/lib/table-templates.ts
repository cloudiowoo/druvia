// apps/admin/src/lib/table-templates.ts

export interface TableTemplate {
  id: string;
  name: string;
  description: string;
  tableName: string;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    primaryKey: boolean;
    defaultValue?: string;
  }>;
}

export const TABLE_TEMPLATES: TableTemplate[] = [
  {
    id: 'users',
    name: '用户表',
    description: '用户账号信息，包含邮箱、用户名、密码哈希等',
    tableName: 'users',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
      { name: 'email', type: 'varchar(255)', nullable: false, primaryKey: false },
      { name: 'username', type: 'varchar(100)', nullable: true, primaryKey: false },
      { name: 'password_hash', type: 'text', nullable: false, primaryKey: false },
      { name: 'avatar_url', type: 'text', nullable: true, primaryKey: false },
      { name: 'status', type: 'varchar(20)', nullable: false, primaryKey: false, defaultValue: "'active'" },
      { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
      { name: 'updated_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
    ],
  },
  {
    id: 'posts',
    name: '文章表',
    description: '博客文章或内容，包含标题、正文、作者等',
    tableName: 'posts',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
      { name: 'title', type: 'varchar(255)', nullable: false, primaryKey: false },
      { name: 'slug', type: 'varchar(255)', nullable: false, primaryKey: false },
      { name: 'content', type: 'text', nullable: true, primaryKey: false },
      { name: 'author_id', type: 'uuid', nullable: true, primaryKey: false },
      { name: 'status', type: 'varchar(20)', nullable: false, primaryKey: false, defaultValue: "'draft'" },
      { name: 'published_at', type: 'timestamptz', nullable: true, primaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
      { name: 'updated_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
    ],
  },
  {
    id: 'orders',
    name: '订单表',
    description: '电商订单，包含订单号、金额、状态等',
    tableName: 'orders',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
      { name: 'order_no', type: 'varchar(50)', nullable: false, primaryKey: false },
      { name: 'user_id', type: 'uuid', nullable: false, primaryKey: false },
      { name: 'total_amount', type: 'integer', nullable: false, primaryKey: false, defaultValue: '0' },
      { name: 'status', type: 'varchar(20)', nullable: false, primaryKey: false, defaultValue: "'pending'" },
      { name: 'paid_at', type: 'timestamptz', nullable: true, primaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
      { name: 'updated_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
    ],
  },
  {
    id: 'products',
    name: '产品表',
    description: '产品目录，包含名称、价格、库存等',
    tableName: 'products',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
      { name: 'name', type: 'varchar(255)', nullable: false, primaryKey: false },
      { name: 'description', type: 'text', nullable: true, primaryKey: false },
      { name: 'price', type: 'integer', nullable: false, primaryKey: false, defaultValue: '0' },
      { name: 'stock', type: 'integer', nullable: false, primaryKey: false, defaultValue: '0' },
      { name: 'category', type: 'varchar(100)', nullable: true, primaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
      { name: 'updated_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
    ],
  },
  {
    id: 'comments',
    name: '评论表',
    description: '通用评论，支持多态关联',
    tableName: 'comments',
    columns: [
      { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
      { name: 'content', type: 'text', nullable: false, primaryKey: false },
      { name: 'user_id', type: 'uuid', nullable: false, primaryKey: false },
      { name: 'target_type', type: 'varchar(50)', nullable: false, primaryKey: false },
      { name: 'target_id', type: 'uuid', nullable: false, primaryKey: false },
      { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
    ],
  },
];
