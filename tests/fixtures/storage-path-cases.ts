export const validStoragePathCases = [
  ['nested path', 'avatars/user one.png', 'avatars/user one.png'],
  ['leading slash', '/avatars/user.png', 'avatars/user.png'],
  ['backslash separator', 'avatars\\user.png', 'avatars/user.png'],
  ['unicode NFC', 'avatars/cafe\u0301.png', 'avatars/caf\u00e9.png'],
] as const

export const invalidStoragePathCases = [
  ['', 'empty'],
  ['/', 'root'],
  ['a//b', 'duplicate separator'],
  ['a/./b', 'dot segment'],
  ['a/../b', 'parent segment'],
  ['a/b/', 'trailing separator'],
  ['a\u0000b', 'NUL'],
  ['a\u001fb', 'control character'],
] as const

export const urlStoragePathCases = [
  ['folder/a b.png', 'folder/a%20b.png'],
  ['folder/\u4e2d\u6587.png', 'folder/%E4%B8%AD%E6%96%87.png'],
  ['folder/a#b?.png', 'folder/a%23b%3F.png'],
  ['folder/100%.png', 'folder/100%25.png'],
] as const
