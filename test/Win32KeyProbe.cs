// Reads win32 console input records (what crossterm-based TUIs like Codex CLI
// consume) and prints each key-down as vk=<code>,ch=<char code>. Exits on 'q'.
// Compiled by test/smoke.mjs with the in-box csc.exe.
using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class Win32KeyProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct KEY_EVENT_RECORD
    {
        public int bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public char UnicodeChar;
        public uint dwControlKeyState;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUT_RECORD
    {
        [FieldOffset(0)]
        public ushort EventType;
        [FieldOffset(4)]
        public KEY_EVENT_RECORD KeyEvent;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ReadConsoleInputW(IntPtr hConsoleInput, [Out] INPUT_RECORD[] lpBuffer, uint nLength, out uint lpNumberOfEventsRead);

    private static int Main()
    {
        IntPtr handle = GetStdHandle(-10);
        INPUT_RECORD[] buffer = new INPUT_RECORD[16];
        StringBuilder events = new StringBuilder();
        DateTime deadline = DateTime.UtcNow.AddSeconds(8);

        while (DateTime.UtcNow < deadline)
        {
            uint read;
            if (!ReadConsoleInputW(handle, buffer, (uint)buffer.Length, out read))
            {
                break;
            }
            uint i;
            for (i = 0; i < read; i++)
            {
                if (buffer[i].EventType != 1)
                {
                    continue;
                }
                KEY_EVENT_RECORD key = buffer[i].KeyEvent;
                if (key.bKeyDown == 0)
                {
                    continue;
                }
                if (key.UnicodeChar == 'q')
                {
                    Console.Out.WriteLine("EVENTS:" + events.ToString());
                    return 0;
                }
                events.Append("vk=" + key.wVirtualKeyCode + ",ch=" + ((int)key.UnicodeChar) + ";");
            }
        }

        Console.Out.WriteLine("EVENTS:timeout:" + events.ToString());
        return 3;
    }
}
