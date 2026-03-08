// apps/admin/src/lib/faker-mapping.ts

export interface FakerRule {
  type: string;
  label: string;
  generate: (faker: any) => unknown;
}

export const FAKER_RULES: Record<string, FakerRule> = {
  email: {
    type: 'email',
    label: '邮箱',
    generate: (faker) => faker.internet.email(),
  },
  username: {
    type: 'username',
    label: '用户名',
    generate: (faker) => faker.internet.username(),
  },
  name: {
    type: 'name',
    label: '姓名',
    generate: (faker) => faker.person.fullName(),
  },
  title: {
    type: 'title',
    label: '标题',
    generate: (faker) => faker.lorem.sentence(),
  },
  content: {
    type: 'content',
    label: '内容',
    generate: (faker) => faker.lorem.paragraphs(1),
  },
  description: {
    type: 'description',
    label: '描述',
    generate: (faker) => faker.lorem.paragraph(),
  },
  integer: {
    type: 'integer',
    label: '整数',
    generate: (faker) => faker.number.int({ min: 1, max: 1000 }),
  },
  boolean: {
    type: 'boolean',
    label: '布尔值',
    generate: (faker) => faker.datatype.boolean(),
  },
  uuid: {
    type: 'uuid',
    label: 'UUID',
    generate: (faker) => faker.string.uuid(),
  },
  timestamp: {
    type: 'timestamp',
    label: '时间戳',
    generate: (faker) => faker.date.recent().toISOString(),
  },
  date: {
    type: 'date',
    label: '日期',
    generate: (faker) => faker.date.recent().toISOString().split('T')[0],
  },
  url: {
    type: 'url',
    label: 'URL',
    generate: (faker) => faker.internet.url(),
  },
  phone: {
    type: 'phone',
    label: '电话',
    generate: (faker) => faker.phone.number(),
  },
  text: {
    type: 'text',
    label: '文本',
    generate: (faker) => faker.lorem.sentence(),
  },
};

// 根据列名和类型推断 Faker 规则
export function inferFakerRule(columnName: string, columnType: string): string {
  const name = columnName.toLowerCase();

  // 按列名匹配
  if (name.includes('email')) return 'email';
  if (name.includes('username') || name === 'user_name') return 'username';
  if (name.includes('name') && !name.includes('username')) return 'name';
  if (name.includes('title')) return 'title';
  if (name.includes('content') || name.includes('body')) return 'content';
  if (name.includes('description') || name.includes('desc')) return 'description';
  if (name.includes('url') || name.includes('link')) return 'url';
  if (name.includes('phone') || name.includes('tel')) return 'phone';

  // 按类型匹配
  const type = columnType.toLowerCase();
  if (type.includes('uuid')) return 'uuid';
  if (type.includes('int') || type.includes('serial')) return 'integer';
  if (type.includes('bool')) return 'boolean';
  if (type.includes('timestamp') || type.includes('time')) return 'timestamp';
  if (type.includes('date')) return 'date';
  if (type.includes('text') || type.includes('varchar') || type.includes('char')) return 'text';

  return 'text'; // 默认
}
