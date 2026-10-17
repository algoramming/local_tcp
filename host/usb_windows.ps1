<#
    Local TCP Bridge - Windows USB helper
    ---------------------------------------------------------------------------
    Started by index.js (the native messaging host) on the first USB request
    and kept running while the browser holds the host. Not meant to be run by
    hand.

    Node.js can't reach Windows' USB printer driver (usbprint.sys) or the print
    spooler without a native addon. This script compiles a small C# class once
    (cached as usb_helper_<hash>.dll next to it) and serves requests over
    stdin/stdout:

      request : <id> TAB <command> [TAB <argument>]...      one per line
      response: one JSON object per line, ASCII only, echoing "id"

    Commands (text arguments are base64-encoded UTF-8):
      PING
      LIST                                   USB printers + installed Windows printers
      WRITE_DEVICE <path> <timeoutMs> <data>  bytes straight to a usbprint.sys device
      WRITE_QUEUE  <name> <docName>   <data>  bytes through the spooler (RAW / XPS_PASS)

    The first line written is {"ready":true,...}, or {"fatal":true,"error":...}
    when the C# could not be loaded (for example under PowerShell Constrained
    Language Mode).
#>

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

// Written for the C# 5 compiler that Windows PowerShell 5.1's Add-Type uses:
// no string interpolation, no "out var", no expression-bodied members.
namespace LocalTcp
{
    public class UsbHelperException : Exception
    {
        public readonly string Code;
        public readonly int Win32;

        public UsbHelperException(string code, string message, int win32) : base(message)
        {
            Code = code;
            Win32 = win32;
        }
    }

    public static class UsbHelper
    {
        // Reported in the ready line; bump when the protocol changes.
        const string HelperVersion = "1";

        const int ChunkSize = 16 * 1024;

        const int DIGCF_PRESENT = 0x02;
        const int DIGCF_DEVICEINTERFACE = 0x10;
        const int ERROR_NO_MORE_ITEMS = 259;
        const int ERROR_IO_PENDING = 997;
        const int ERROR_INVALID_DATATYPE = 1804;
        const uint GENERIC_WRITE = 0x40000000;
        const uint FILE_SHARE_READ = 0x1;
        const uint FILE_SHARE_WRITE = 0x2;
        const uint OPEN_EXISTING = 3;
        const uint FILE_FLAG_OVERLAPPED = 0x40000000;
        const uint IOCTL_USBPRINT_GET_1284_ID = 0x220034;
        const int KEY_READ = 0x20019;
        const int PRINTER_ENUM_LOCAL = 0x2;
        const int PRINTER_ENUM_CONNECTIONS = 0x4;
        const int PRINTER_DRIVER_XPS = 0x2;

        static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

        // The device interface usbprint.sys registers for every USB printer-class device.
        static readonly Guid GUID_DEVINTERFACE_USBPRINT = new Guid("28d78fad-5a12-11d1-ae5b-0000f803a8c2");

        // DEVPKEY_Device_BusReportedDeviceDesc: the product string the printer reports.
        static readonly Guid DEVPKEY_BusReportedDeviceDesc = new Guid("540b947e-8b40-45bc-a8a2-6a0b894cbda2");

        static TextWriter output;

        // -- Win32 structures ------------------------------------------------

        [StructLayout(LayoutKind.Sequential)]
        struct SP_DEVICE_INTERFACE_DATA
        {
            public int cbSize;
            public Guid InterfaceClassGuid;
            public int Flags;
            public IntPtr Reserved;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct SP_DEVINFO_DATA
        {
            public int cbSize;
            public Guid ClassGuid;
            public int DevInst;
            public IntPtr Reserved;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct DEVPROPKEY
        {
            public Guid fmtid;
            public int pid;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct PRINTER_INFO_2
        {
            public string pServerName;
            public string pPrinterName;
            public string pShareName;
            public string pPortName;
            public string pDriverName;
            public string pComment;
            public string pLocation;
            public IntPtr pDevMode;
            public string pSepFile;
            public string pPrintProcessor;
            public string pDatatype;
            public string pParameters;
            public IntPtr pSecurityDescriptor;
            public int Attributes;
            public int Priority;
            public int DefaultPriority;
            public int StartTime;
            public int UntilTime;
            public int Status;
            public int cJobs;
            public int AveragePPM;
        }

        // Only cVersion and dwPrinterDriverAttributes are read; the rest is layout.
        // FILETIMEs are two ints (4-byte aligned), DWORDLONGs are longs (8-byte aligned).
        [StructLayout(LayoutKind.Sequential)]
        struct DRIVER_INFO_8
        {
            public int cVersion;
            public IntPtr pName;
            public IntPtr pEnvironment;
            public IntPtr pDriverPath;
            public IntPtr pDataFile;
            public IntPtr pConfigFile;
            public IntPtr pHelpFile;
            public IntPtr pDependentFiles;
            public IntPtr pMonitorName;
            public IntPtr pDefaultDataType;
            public IntPtr pszzPreviousNames;
            public int ftDriverDateLow;
            public int ftDriverDateHigh;
            public long dwlDriverVersion;
            public IntPtr pszMfgName;
            public IntPtr pszOEMUrl;
            public IntPtr pszHardwareID;
            public IntPtr pszProvider;
            public IntPtr pszPrintProcessor;
            public IntPtr pszVendorSetup;
            public IntPtr pszzColorProfiles;
            public IntPtr pszInfPath;
            public int dwPrinterDriverAttributes;
            public IntPtr pszzCoreDriverDependencies;
            public int ftMinInboxDriverVerDateLow;
            public int ftMinInboxDriverVerDateHigh;
            public long dwlMinInboxDriverVerVersion;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        class DOC_INFO_1
        {
            public string pDocName;
            public string pOutputFile;
            public string pDatatype;
        }

        // -- Win32 functions -------------------------------------------------

        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, IntPtr enumerator, IntPtr hwndParent, int flags);

        [DllImport("setupapi.dll", SetLastError = true)]
        static extern bool SetupDiEnumDeviceInterfaces(IntPtr deviceInfoSet, IntPtr deviceInfoData, ref Guid interfaceClassGuid, int memberIndex, ref SP_DEVICE_INTERFACE_DATA deviceInterfaceData);

        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr deviceInfoSet, ref SP_DEVICE_INTERFACE_DATA deviceInterfaceData, IntPtr deviceInterfaceDetailData, int deviceInterfaceDetailDataSize, out int requiredSize, ref SP_DEVINFO_DATA deviceInfoData);

        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetupDiGetDeviceInstanceId(IntPtr deviceInfoSet, ref SP_DEVINFO_DATA deviceInfoData, StringBuilder deviceInstanceId, int deviceInstanceIdSize, out int requiredSize);

        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetupDiGetDeviceProperty(IntPtr deviceInfoSet, ref SP_DEVINFO_DATA deviceInfoData, ref DEVPROPKEY propertyKey, out int propertyType, byte[] propertyBuffer, int propertyBufferSize, out int requiredSize, int flags);

        [DllImport("setupapi.dll", SetLastError = true)]
        static extern IntPtr SetupDiOpenDeviceInterfaceRegKey(IntPtr deviceInfoSet, ref SP_DEVICE_INTERFACE_DATA deviceInterfaceData, int reserved, int samDesired);

        [DllImport("setupapi.dll", SetLastError = true)]
        static extern bool SetupDiDestroyDeviceInfoList(IntPtr deviceInfoSet);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFile(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool WriteFile(SafeFileHandle file, IntPtr buffer, int numberOfBytesToWrite, IntPtr numberOfBytesWritten, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetOverlappedResult(SafeFileHandle file, IntPtr overlapped, out int numberOfBytesTransferred, bool wait);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CancelIoEx(SafeFileHandle file, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DeviceIoControl(SafeFileHandle device, uint ioControlCode, IntPtr inBuffer, int inBufferSize, byte[] outBuffer, int outBufferSize, out int bytesReturned, IntPtr overlapped);

        [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool EnumPrinters(int flags, string name, int level, IntPtr printerEnum, int bufferSize, out int needed, out int returned);

        [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool GetDefaultPrinter(StringBuilder buffer, ref int bufferSize);

        [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);

        [DllImport("winspool.drv", SetLastError = true)]
        static extern bool ClosePrinter(IntPtr printer);

        [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool GetPrinterDriver(IntPtr printer, string environment, int level, IntPtr driverInfo, int bufferSize, out int needed);

        [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern int StartDocPrinter(IntPtr printer, int level, [In] DOC_INFO_1 docInfo);

        [DllImport("winspool.drv", SetLastError = true)]
        static extern bool StartPagePrinter(IntPtr printer);

        [DllImport("winspool.drv", SetLastError = true)]
        static extern bool WritePrinter(IntPtr printer, IntPtr buffer, int count, out int written);

        [DllImport("winspool.drv", SetLastError = true)]
        static extern bool EndPagePrinter(IntPtr printer);

        [DllImport("winspool.drv", SetLastError = true)]
        static extern bool EndDocPrinter(IntPtr printer);

        [DllImport("winspool.drv", SetLastError = true)]
        static extern bool AbortPrinter(IntPtr printer);

        // -- Request loop ----------------------------------------------------

        public static void Run()
        {
            StreamWriter writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            writer.AutoFlush = true;
            output = writer;
            StreamReader input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);

            Emit("{\"ready\":true,\"helper\":" + Q(HelperVersion) + "}");

            string line;
            while ((line = input.ReadLine()) != null)   // null: the host went away
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                string[] parts = line.Split('\t');
                string body;
                try
                {
                    body = Handle(parts);
                }
                catch (UsbHelperException e)
                {
                    body = Failure(e.Code, e.Message, e.Win32);
                }
                catch (FormatException e)
                {
                    body = Failure("invalidRequest", e.Message, 0);
                }
                catch (Exception e)
                {
                    body = Failure("ioError", e.Message, 0);
                }
                Emit("{\"id\":" + Q(parts[0]) + "," + body + "}");
            }
        }

        static string Handle(string[] p)
        {
            string command = p.Length > 1 ? p[1] : "";
            if (command == "PING") return "\"ok\":true";
            if (command == "LIST") return List();
            if (command == "WRITE_DEVICE" && p.Length >= 5)
                return WriteDevice(Text(p[2]), ParseTimeout(p[3]), Convert.FromBase64String(p[4]));
            if (command == "WRITE_QUEUE" && p.Length >= 5)
                return WriteQueue(Text(p[2]), Text(p[3]), Convert.FromBase64String(p[4]));
            throw new UsbHelperException("invalidRequest", "Unknown or incomplete command: " + command, 0);
        }

        // -- LIST ------------------------------------------------------------

        static string List()
        {
            StringBuilder sb = new StringBuilder("\"ok\":true,\"devices\":[");
            AppendDevices(sb);
            sb.Append(']');

            // Built separately so a spooler failure can't leave half an array behind.
            StringBuilder queues = new StringBuilder();
            bool queueError = false;
            try
            {
                AppendQueues(queues);
            }
            catch (Exception)
            {
                queueError = true;
                queues.Length = 0;
            }
            sb.Append(",\"queues\":[").Append(queues.ToString()).Append(']');
            sb.Append(",\"queueError\":").Append(queueError ? "true" : "false");

            string defaultQueue = null;
            try { defaultQueue = DefaultPrinterName(); } catch (Exception) { }
            sb.Append(",\"defaultQueue\":").Append(Q(defaultQueue));
            return sb.ToString();
        }

        static void AppendDevices(StringBuilder sb)
        {
            Guid guid = GUID_DEVINTERFACE_USBPRINT;
            IntPtr set = SetupDiGetClassDevs(ref guid, IntPtr.Zero, IntPtr.Zero, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
            if (set == INVALID_HANDLE_VALUE)
                throw Win32Failure(Marshal.GetLastWin32Error(), "Could not list USB printers");
            try
            {
                bool first = true;
                for (int i = 0; ; i++)
                {
                    SP_DEVICE_INTERFACE_DATA iface = new SP_DEVICE_INTERFACE_DATA();
                    iface.cbSize = Marshal.SizeOf(typeof(SP_DEVICE_INTERFACE_DATA));
                    if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref guid, i, ref iface))
                    {
                        if (Marshal.GetLastWin32Error() == ERROR_NO_MORE_ITEMS) break;
                        continue;
                    }
                    try
                    {
                        string device = DescribeDevice(set, ref iface);
                        if (device == null) continue;
                        if (!first) sb.Append(',');
                        sb.Append(device);
                        first = false;
                    }
                    catch (Exception)
                    {
                        // One odd device must not hide the others.
                    }
                }
            }
            finally
            {
                SetupDiDestroyDeviceInfoList(set);
            }
        }

        static string DescribeDevice(IntPtr set, ref SP_DEVICE_INTERFACE_DATA iface)
        {
            SP_DEVINFO_DATA dev = new SP_DEVINFO_DATA();
            dev.cbSize = Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
            int required;
            SetupDiGetDeviceInterfaceDetail(set, ref iface, IntPtr.Zero, 0, out required, ref dev);
            if (required <= 0) return null;

            string path;
            IntPtr detail = Marshal.AllocHGlobal(required);
            try
            {
                // SP_DEVICE_INTERFACE_DETAIL_DATA_W is a DWORD cbSize followed by the
                // path. cbSize is the size of the fixed part including padding: 8 on
                // 64-bit, 6 on 32-bit. The path itself always starts at offset 4.
                Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 6);
                if (!SetupDiGetDeviceInterfaceDetail(set, ref iface, detail, required, out required, ref dev)) return null;
                path = Marshal.PtrToStringUni(IntPtr.Add(detail, 4));
            }
            finally
            {
                Marshal.FreeHGlobal(detail);
            }
            if (string.IsNullOrEmpty(path)) return null;

            bool busy;
            string ieee1284 = Read1284Id(path, out busy);

            StringBuilder sb = new StringBuilder("{");
            sb.Append("\"path\":").Append(Q(path));
            sb.Append(",\"instanceId\":").Append(Q(InstanceId(set, ref dev)));
            sb.Append(",\"busName\":").Append(Q(BusReportedName(set, ref dev)));
            sb.Append(",\"port\":").Append(Q(PortName(set, ref iface)));
            sb.Append(",\"ieee1284\":").Append(Q(ieee1284));
            sb.Append(",\"busy\":").Append(busy ? "true" : "false");
            sb.Append('}');
            return sb.ToString();
        }

        static string InstanceId(IntPtr set, ref SP_DEVINFO_DATA dev)
        {
            StringBuilder sb = new StringBuilder(512);
            int required;
            return SetupDiGetDeviceInstanceId(set, ref dev, sb, sb.Capacity, out required) ? sb.ToString() : null;
        }

        static string BusReportedName(IntPtr set, ref SP_DEVINFO_DATA dev)
        {
            DEVPROPKEY key = new DEVPROPKEY();
            key.fmtid = DEVPKEY_BusReportedDeviceDesc;
            key.pid = 4;
            byte[] buffer = new byte[1024];
            int type;
            int required;
            if (!SetupDiGetDeviceProperty(set, ref dev, ref key, out type, buffer, buffer.Length, out required, 0)) return null;
            int length = Math.Max(0, Math.Min(required, buffer.Length));
            string name = Encoding.Unicode.GetString(buffer, 0, length).TrimEnd('\0').Trim();
            return name.Length == 0 ? null : name;
        }

        // The spooler port (USB001, USB002, ...) usbprint.sys assigned to the device,
        // from the interface's "Device Parameters" key. Lets the host tie an installed
        // Windows printer to the USB device it prints on.
        static string PortName(IntPtr set, ref SP_DEVICE_INTERFACE_DATA iface)
        {
            IntPtr handle = SetupDiOpenDeviceInterfaceRegKey(set, ref iface, 0, KEY_READ);
            if (handle == INVALID_HANDLE_VALUE || handle == IntPtr.Zero) return null;
            using (RegistryKey key = RegistryKey.FromHandle(new SafeRegistryHandle(handle, true)))
            {
                object number = key.GetValue("Port Number");
                if (!(number is int)) return null;
                string prefix = key.GetValue("Base Name") as string;
                if (string.IsNullOrEmpty(prefix)) prefix = "USB";
                return prefix + ((int)number).ToString("000", CultureInfo.InvariantCulture);
            }
        }

        // The printer's IEEE 1284 Device ID ("MFG:...;MDL:...;CMD:ESC/POS;"). Opened
        // with no read/write access and closed at once, so it never holds the printer.
        static string Read1284Id(string path, out bool busy)
        {
            busy = false;
            using (SafeFileHandle handle = CreateFile(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero))
            {
                if (handle.IsInvalid)
                {
                    int err = Marshal.GetLastWin32Error();
                    busy = err == 5 || err == 32 || err == 170;
                    return null;
                }
                // Kept well under 4 KB: some devices fail the request with larger buffers.
                byte[] buffer = new byte[1024];
                int got;
                if (!DeviceIoControl(handle, IOCTL_USBPRINT_GET_1284_ID, IntPtr.Zero, 0, buffer, buffer.Length, out got, IntPtr.Zero) || got <= 2)
                    return null;
                // A 2-byte length (big-endian per IEEE 1284, little-endian on some
                // printers) that counts itself, then the ID.
                int big = (buffer[0] << 8) | buffer[1];
                int little = buffer[0] | (buffer[1] << 8);
                int length = (big >= 2 && big <= got) ? big : (little >= 2 && little <= got) ? little : got;
                string id = Encoding.ASCII.GetString(buffer, 2, length - 2).TrimEnd('\0', ' ', '\r', '\n');
                return id.Length == 0 ? null : id;
            }
        }

        static void AppendQueues(StringBuilder sb)
        {
            int flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
            int needed;
            int returned;
            EnumPrinters(flags, null, 2, IntPtr.Zero, 0, out needed, out returned);
            if (needed <= 0) return;
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!EnumPrinters(flags, null, 2, buffer, needed, out needed, out returned))
                    throw Win32Failure(Marshal.GetLastWin32Error(), "Could not list Windows printers");
                int size = Marshal.SizeOf(typeof(PRINTER_INFO_2));
                for (int i = 0; i < returned; i++)
                {
                    PRINTER_INFO_2 info = (PRINTER_INFO_2)Marshal.PtrToStructure(IntPtr.Add(buffer, i * size), typeof(PRINTER_INFO_2));
                    if (i > 0) sb.Append(',');
                    sb.Append("{\"name\":").Append(Q(info.pPrinterName));
                    sb.Append(",\"port\":").Append(Q(info.pPortName));
                    sb.Append(",\"driver\":").Append(Q(info.pDriverName));
                    sb.Append(",\"location\":").Append(Q(info.pLocation));
                    sb.Append(",\"status\":").Append(info.Status.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"attributes\":").Append(info.Attributes.ToString(CultureInfo.InvariantCulture));
                    sb.Append('}');
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        static string DefaultPrinterName()
        {
            int size = 0;
            GetDefaultPrinter(null, ref size);
            if (size <= 0) return null;
            StringBuilder sb = new StringBuilder(size);
            return GetDefaultPrinter(sb, ref size) ? sb.ToString() : null;
        }

        // -- WRITE_DEVICE ----------------------------------------------------

        static string WriteDevice(string path, int timeoutMs, byte[] data)
        {
            if (data.Length == 0) throw new UsbHelperException("invalidRequest", "Nothing to print.", 0);
            using (SafeFileHandle handle = CreateFile(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, IntPtr.Zero))
            {
                if (handle.IsInvalid) throw Win32Failure(Marshal.GetLastWin32Error(), "Could not open the printer");
                IntPtr buffer = Marshal.AllocHGlobal(ChunkSize);
                IntPtr overlapped = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NativeOverlapped)));
                try
                {
                    using (ManualResetEvent signal = new ManualResetEvent(false))
                    {
                        int offset = 0;
                        while (offset < data.Length)
                        {
                            int count = Math.Min(ChunkSize, data.Length - offset);
                            Marshal.Copy(data, offset, buffer, count);
                            int written = WriteChunk(handle, buffer, count, overlapped, signal, timeoutMs);
                            if (written <= 0) throw new UsbHelperException("ioError", "The printer accepted no data.", 0);
                            offset += written;
                        }
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(overlapped);
                    Marshal.FreeHGlobal(buffer);
                }
            }
            return "\"ok\":true,\"bytes\":" + data.Length.ToString(CultureInfo.InvariantCulture);
        }

        // One overlapped write, so a printer that stops taking data (no paper,
        // cover open, switched off) fails after timeoutMs instead of hanging.
        static int WriteChunk(SafeFileHandle handle, IntPtr buffer, int count, IntPtr overlapped, ManualResetEvent signal, int timeoutMs)
        {
            signal.Reset();
            NativeOverlapped o = new NativeOverlapped();
            o.EventHandle = signal.SafeWaitHandle.DangerousGetHandle();
            Marshal.StructureToPtr(o, overlapped, false);

            if (!WriteFile(handle, buffer, count, IntPtr.Zero, overlapped))
            {
                int err = Marshal.GetLastWin32Error();
                if (err != ERROR_IO_PENDING) throw Win32Failure(err, "Could not send data to the printer");
                if (!signal.WaitOne(timeoutMs))
                {
                    CancelIoEx(handle, overlapped);
                    int ignored;
                    // Wait for the cancellation to land before the buffers are freed.
                    GetOverlappedResult(handle, overlapped, out ignored, true);
                    throw new UsbHelperException("timeout", "The printer did not take the data in time.", 0);
                }
            }
            int written;
            if (!GetOverlappedResult(handle, overlapped, out written, true))
                throw Win32Failure(Marshal.GetLastWin32Error(), "Could not send data to the printer");
            return written;
        }

        // -- WRITE_QUEUE -----------------------------------------------------

        static string WriteQueue(string name, string docName, byte[] data)
        {
            if (data.Length == 0) throw new UsbHelperException("invalidRequest", "Nothing to print.", 0);
            IntPtr printer;
            if (!OpenPrinter(name, out printer, IntPtr.Zero))
                throw Win32Failure(Marshal.GetLastWin32Error(), "Could not open the Windows printer");
            try
            {
                // v4 and XPS-based (XPSDrv) drivers turn a RAW job into an empty spool
                // file; they pass bytes through only with the XPS_PASS data type.
                string datatype = UsesXpsDriver(printer) ? "XPS_PASS" : "RAW";
                DOC_INFO_1 doc = new DOC_INFO_1();
                doc.pDocName = string.IsNullOrEmpty(docName) ? "Local TCP receipt" : docName;
                doc.pDatatype = datatype;
                int job = StartDocPrinter(printer, 1, doc);
                if (job == 0)
                {
                    int err = Marshal.GetLastWin32Error();
                    if (err != ERROR_INVALID_DATATYPE || datatype == "XPS_PASS")
                        throw Win32Failure(err, "Could not start the print job");
                    datatype = "XPS_PASS";
                    doc.pDatatype = datatype;
                    job = StartDocPrinter(printer, 1, doc);
                    if (job == 0) throw Win32Failure(Marshal.GetLastWin32Error(), "Could not start the print job");
                }

                bool ended = false;
                try
                {
                    if (!StartPagePrinter(printer)) throw Win32Failure(Marshal.GetLastWin32Error(), "Could not start the print job");
                    IntPtr buffer = Marshal.AllocHGlobal(data.Length);
                    try
                    {
                        Marshal.Copy(data, 0, buffer, data.Length);
                        int offset = 0;
                        while (offset < data.Length)
                        {
                            int written;
                            if (!WritePrinter(printer, IntPtr.Add(buffer, offset), data.Length - offset, out written))
                                throw Win32Failure(Marshal.GetLastWin32Error(), "Could not send data to the printer");
                            if (written <= 0) throw new UsbHelperException("ioError", "The print queue accepted no data.", 0);
                            offset += written;
                        }
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(buffer);
                    }
                    EndPagePrinter(printer);
                    if (!EndDocPrinter(printer)) throw Win32Failure(Marshal.GetLastWin32Error(), "Could not finish the print job");
                    ended = true;
                }
                finally
                {
                    // A half-written job must not print: drop it instead of ending it.
                    if (!ended) AbortPrinter(printer);
                }
                return "\"ok\":true,\"bytes\":" + data.Length.ToString(CultureInfo.InvariantCulture) +
                       ",\"jobId\":" + job.ToString(CultureInfo.InvariantCulture) +
                       ",\"datatype\":" + Q(datatype);
            }
            finally
            {
                ClosePrinter(printer);
            }
        }

        static bool UsesXpsDriver(IntPtr printer)
        {
            int needed;
            GetPrinterDriver(printer, null, 8, IntPtr.Zero, 0, out needed);
            if (needed <= 0) return false;
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetPrinterDriver(printer, null, 8, buffer, needed, out needed)) return false;
                DRIVER_INFO_8 info = (DRIVER_INFO_8)Marshal.PtrToStructure(buffer, typeof(DRIVER_INFO_8));
                return info.cVersion >= 4 || (info.dwPrinterDriverAttributes & PRINTER_DRIVER_XPS) != 0;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        // -- Helpers ---------------------------------------------------------

        static UsbHelperException Win32Failure(int err, string context)
        {
            string code;
            switch (err)
            {
                case 2:     // ERROR_FILE_NOT_FOUND
                case 3:     // ERROR_PATH_NOT_FOUND
                case 21:    // ERROR_NOT_READY
                case 433:   // ERROR_NO_SUCH_DEVICE
                case 1167:  // ERROR_DEVICE_NOT_CONNECTED
                case 1801:  // ERROR_INVALID_PRINTER_NAME
                    code = "notFound";
                    break;
                case 5:     // ERROR_ACCESS_DENIED (held by the spooler during a job)
                case 32:    // ERROR_SHARING_VIOLATION
                case 170:   // ERROR_BUSY
                    code = "busy";
                    break;
                case 995:   // ERROR_OPERATION_ABORTED
                case 1460:  // ERROR_TIMEOUT
                    code = "timeout";
                    break;
                default:
                    code = "ioError";
                    break;
            }
            return new UsbHelperException(code, context + ": " + new Win32Exception(err).Message, err);
        }

        static string Failure(string code, string message, int win32)
        {
            return "\"ok\":false,\"code\":" + Q(code) + ",\"error\":" + Q(message) +
                   ",\"win32\":" + win32.ToString(CultureInfo.InvariantCulture);
        }

        static string Text(string base64)
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(base64));
        }

        static int ParseTimeout(string text)
        {
            int ms = int.Parse(text, NumberStyles.Integer, CultureInfo.InvariantCulture);
            return Math.Max(1000, Math.Min(600000, ms));
        }

        static void Emit(string json)
        {
            output.Write(json);
            output.Write('\n');
        }

        // JSON string literal. Everything outside printable ASCII is escaped, so the
        // output is plain ASCII whatever the console code page.
        static string Q(string s)
        {
            if (s == null) return "null";
            StringBuilder sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }
}
'@

function Send-Fatal([string]$Message) {
    $json = '{"fatal":true,"error":' + (ConvertTo-Json -InputObject $Message -Compress) + '}'
    [Console]::Out.Write($json + "`n")
    [Console]::Out.Flush()
}

function Import-UsbHelper {
    if ('LocalTcp.UsbHelper' -as [type]) { return }

    # Compiling costs 1-3 s (Add-Type runs csc.exe); loading a compiled DLL takes
    # milliseconds. So compile once per version of the C# above and reuse the DLL.
    $sha = [Security.Cryptography.SHA256]::Create()
    $hash = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($source)) |
        Select-Object -First 8 | ForEach-Object { $_.ToString('x2') }) -join ''
    $dll = Join-Path $PSScriptRoot "usb_helper_$hash.dll"

    try {
        if (-not (Test-Path -LiteralPath $dll)) {
            $tmp = Join-Path $PSScriptRoot ('usb_helper_build_' + [Guid]::NewGuid().ToString('N') + '.dll')
            Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $tmp -OutputType Library
            Move-Item -LiteralPath $tmp -Destination $dll -Force
            # Drop DLLs compiled from older versions (best effort: one may still be loaded).
            Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'usb_helper_*.dll' |
                Where-Object { $_.FullName -ne $dll -and $_.Name -notlike 'usb_helper_build_*' } |
                Remove-Item -Force -ErrorAction SilentlyContinue
        }
        if (-not ('LocalTcp.UsbHelper' -as [type])) {
            # Loaded from bytes rather than from the path, so the file is never
            # locked and the uninstaller can always delete it.
            [void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($dll))
        }
    } catch {
        # Read-only folder, a damaged cached DLL, ...: compile in memory instead,
        # and drop a damaged DLL so the next start can cache a good one.
        if (-not ('LocalTcp.UsbHelper' -as [type])) {
            Remove-Item -LiteralPath $dll -Force -ErrorAction SilentlyContinue
            Add-Type -TypeDefinition $source -Language CSharp
        }
    }
}

try {
    Import-UsbHelper
} catch {
    Send-Fatal $_.Exception.Message
    exit 2
}

[LocalTcp.UsbHelper]::Run()
