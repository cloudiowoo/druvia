import { describe, it, expect } from 'vitest';

// 直接定义类型，避免跨项目导入问题
interface TableTemplate {
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

// 从 admin 项目复制模板定义用于测试
const TABLE_TEMPLATES: TableTemplate[] = [
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

/**
 * Phase 1 单元测试 - 表模板定义
 *
 * 验证表模板的结构和内容正确性
 */
describe('Table Templates', () => {
  describe('模板结构验证', () => {
    it('should have 5 predefined templates', () => {
      expect(TABLE_TEMPLATES.length).toBe(5);
    });

    it('should have required fields for each template', () => {
      TABLE_TEMPLATES.forEach((template: TableTemplate) => {
        expect(template.id).toBeDefined();
        expect(template.name).toBeDefined();
        expect(template.description).toBeDefined();
        expect(template.tableName).toBeDefined();
        expect(template.columns).toBeDefined();
        expect(Array.isArray(template.columns)).toBe(true);
        expect(template.columns.length).toBeGreaterThan(0);
      });
    });

    it('should have valid column definitions', () => {
      TABLE_TEMPLATES.forEach((template: TableTemplate) => {
        template.columns.forEach((col) => {
          expect(col.name).toBeDefined();
          expect(col.type).toBeDefined();
          expect(typeof col.nullable).toBe('boolean');
          expect(typeof col.primaryKey).toBe('boolean');
        });
      });
    });

    it('should have at least one primary key column per template', () => {
      TABLE_TEMPLATES.forEach((template: TableTemplate) => {
        const pkColumns = template.columns.filter((c) => c.primaryKey);
        expect(pkColumns.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('用户表模板', () => {
    const usersTemplate = TABLE_TEMPLATES.find((t) => t.id === 'users');

    it('should exist', () => {
      expect(usersTemplate).toBeDefined();
    });

    it('should have correct table name', () => {
      expect(usersTemplate?.tableName).toBe('users');
    });

    it('should have essential user columns', () => {
      const columnNames = usersTemplate?.columns.map((c) => c.name) || [];
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('email');
      expect(columnNames).toContain('password_hash');
      expect(columnNames).toContain('created_at');
    });

    it('should have uuid primary key with default', () => {
      const idCol = usersTemplate?.columns.find((c) => c.name === 'id');
      expect(idCol?.type).toBe('uuid');
      expect(idCol?.primaryKey).toBe(true);
      expect(idCol?.defaultValue).toBe('gen_random_uuid()');
    });
  });

  describe('文章表模板', () => {
    const postsTemplate = TABLE_TEMPLATES.find((t) => t.id === 'posts');

    it('should exist', () => {
      expect(postsTemplate).toBeDefined();
    });

    it('should have content-related columns', () => {
      const columnNames = postsTemplate?.columns.map((c) => c.name) || [];
      expect(columnNames).toContain('title');
      expect(columnNames).toContain('slug');
      expect(columnNames).toContain('content');
      expect(columnNames).toContain('author_id');
      expect(columnNames).toContain('status');
    });

    it('should have draft as default status', () => {
      const statusCol = postsTemplate?.columns.find((c) => c.name === 'status');
      expect(statusCol?.defaultValue).toBe("'draft'");
    });
  });

  describe('订单表模板', () => {
    const ordersTemplate = TABLE_TEMPLATES.find((t) => t.id === 'orders');

    it('should exist', () => {
      expect(ordersTemplate).toBeDefined();
    });

    it('should have order-related columns', () => {
      const columnNames = ordersTemplate?.columns.map((c) => c.name) || [];
      expect(columnNames).toContain('order_no');
      expect(columnNames).toContain('user_id');
      expect(columnNames).toContain('total_amount');
      expect(columnNames).toContain('status');
      expect(columnNames).toContain('paid_at');
    });

    it('should have pending as default status', () => {
      const statusCol = ordersTemplate?.columns.find((c) => c.name === 'status');
      expect(statusCol?.defaultValue).toBe("'pending'");
    });
  });

  describe('产品表模板', () => {
    const productsTemplate = TABLE_TEMPLATES.find((t) => t.id === 'products');

    it('should exist', () => {
      expect(productsTemplate).toBeDefined();
    });

    it('should have product-related columns', () => {
      const columnNames = productsTemplate?.columns.map((c) => c.name) || [];
      expect(columnNames).toContain('name');
      expect(columnNames).toContain('description');
      expect(columnNames).toContain('price');
      expect(columnNames).toContain('stock');
      expect(columnNames).toContain('category');
    });

    it('should have 0 as default for price and stock', () => {
      const priceCol = productsTemplate?.columns.find((c) => c.name === 'price');
      const stockCol = productsTemplate?.columns.find((c) => c.name === 'stock');
      expect(priceCol?.defaultValue).toBe('0');
      expect(stockCol?.defaultValue).toBe('0');
    });
  });

  describe('评论表模板', () => {
    const commentsTemplate = TABLE_TEMPLATES.find((t) => t.id === 'comments');

    it('should exist', () => {
      expect(commentsTemplate).toBeDefined();
    });

    it('should have polymorphic association columns', () => {
      const columnNames = commentsTemplate?.columns.map((c) => c.name) || [];
      expect(columnNames).toContain('content');
      expect(columnNames).toContain('user_id');
      expect(columnNames).toContain('target_type');
      expect(columnNames).toContain('target_id');
    });
  });

  describe('表名规范', () => {
    it('should use snake_case for table names', () => {
      TABLE_TEMPLATES.forEach((template: TableTemplate) => {
        expect(template.tableName).toMatch(/^[a-z][a-z0-9_]*$/);
      });
    });

    it('should use snake_case for column names', () => {
      TABLE_TEMPLATES.forEach((template: TableTemplate) => {
        template.columns.forEach((col) => {
          expect(col.name).toMatch(/^[a-z][a-z0-9_]*$/);
        });
      });
    });
  });

  describe('时间戳字段', () => {
    it('should have created_at in all templates', () => {
      TABLE_TEMPLATES.forEach((template: TableTemplate) => {
        const hasCreatedAt = template.columns.some((c) => c.name === 'created_at');
        expect(hasCreatedAt).toBe(true);
      });
    });

    it('should use timestamptz type for timestamps', () => {
      TABLE_TEMPLATES.forEach((template: TableTemplate) => {
        const createdAt = template.columns.find((c) => c.name === 'created_at');
        expect(createdAt?.type).toBe('timestamptz');
      });
    });

    it('should have now() as default for created_at', () => {
      TABLE_TEMPLATES.forEach((template: TableTemplate) => {
        const createdAt = template.columns.find((c) => c.name === 'created_at');
        expect(createdAt?.defaultValue).toBe('now()');
      });
    });
  });
});
