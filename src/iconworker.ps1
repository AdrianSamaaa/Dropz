# Long-running shell helper for Drops.
# Reads lines "<id>\t<base64 utf8 path>\t<op>" from stdin and answers "<id>\t<result>".
#  - op = a number: icon of that size, answered as base64 PNG (empty = failure). Uses the
#    Windows shell (IShellItemImageFactory) so shortcuts, .url files and folders get the
#    same crisp icon Explorer shows, without the shortcut arrow.
#  - op = create | delete | update | updatedir: tells Explorer the path changed, so the
#    desktop redraws right away instead of showing icons that are no longer there.
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class DropsShellIcon {
    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItemImageFactory {
        [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SIZE { public int cx; public int cy; }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern void SHChangeNotify(int eventId, uint flags, string item1, IntPtr item2);

    private const int SIIGBF_ICONONLY = 0x4;
    private const uint SHCNF_PATHW_FLUSHNOWAIT = 0x0005 | 0x3000;

    public static void Notify(string path, string what) {
        path = path.Replace('/', '\\');
        bool dir = Directory.Exists(path);
        switch (what) {
            case "create":    Send(dir ? 0x8 : 0x2, path); break;          // SHCNE_MKDIR / SHCNE_CREATE
            case "delete":    Send(0x4, path); break;                      // SHCNE_DELETE
            case "update":    Send(0x800, path); Send(0x2000, path); break; // SHCNE_ATTRIBUTES + SHCNE_UPDATEITEM
            case "updatedir": Send(0x1000, path); break;                   // SHCNE_UPDATEDIR
        }
    }

    private static void Send(int eventId, string path) {
        SHChangeNotify(eventId, SHCNF_PATHW_FLUSHNOWAIT, path, IntPtr.Zero);
    }

    public static string GetPngBase64(string path, int size) {
        Guid iid = typeof(IShellItemImageFactory).GUID;
        IShellItemImageFactory factory;
        path = path.Replace('/', '\\');
        if (SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out factory) != 0 || factory == null) return "";
        IntPtr hbm = IntPtr.Zero;
        try {
            SIZE sz; sz.cx = size; sz.cy = size;
            if (factory.GetImage(sz, SIIGBF_ICONONLY, out hbm) != 0 || hbm == IntPtr.Zero) return "";
            using (Bitmap src = Image.FromHbitmap(hbm)) {
                int w = src.Width, h = src.Height, row = w * 4;
                Rectangle r = new Rectangle(0, 0, w, h);
                // FromHbitmap drops the alpha channel from the pixel format but keeps the bytes;
                // read them raw (row by row: stride can be negative) and rebuild with alpha.
                byte[] buf = new byte[row * h];
                BitmapData sd = src.LockBits(r, ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
                for (int y = 0; y < h; y++) Marshal.Copy(new IntPtr(sd.Scan0.ToInt64() + (long)y * sd.Stride), buf, y * row, row);
                src.UnlockBits(sd);

                bool hasAlpha = false;
                for (int i = 3; i < buf.Length; i += 4) { if (buf[i] != 0) { hasAlpha = true; break; } }
                if (!hasAlpha) { for (int i = 3; i < buf.Length; i += 4) buf[i] = 255; }

                using (Bitmap dst = new Bitmap(w, h, PixelFormat.Format32bppPArgb)) {
                    BitmapData dd = dst.LockBits(r, ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
                    for (int y = 0; y < h; y++) Marshal.Copy(buf, y * row, new IntPtr(dd.Scan0.ToInt64() + (long)y * dd.Stride), row);
                    dst.UnlockBits(dd);
                    using (MemoryStream ms = new MemoryStream()) {
                        dst.Save(ms, ImageFormat.Png);
                        return Convert.ToBase64String(ms.ToArray());
                    }
                }
            }
        } finally {
            if (hbm != IntPtr.Zero) DeleteObject(hbm);
            Marshal.ReleaseComObject(factory);
        }
    }
}
'@

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $parts = $line.Split("`t")
    $result = ''
    try {
        $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
        $op = $parts[2]
        if ($op -match '^\d+$') {
            $result = [DropsShellIcon]::GetPngBase64($path, [int]$op)
        } else {
            [DropsShellIcon]::Notify($path, $op)
            $result = 'ok'
        }
    } catch {
        $result = ''
    }
    [Console]::Out.WriteLine("$($parts[0])`t$result")
    [Console]::Out.Flush()
}
