using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using ComIStream = System.Runtime.InteropServices.ComTypes.IStream;

// Sheet-fed scanning (Epson FastFoto FF-680W) through WIA 2.0.
//
// The WIA 1 automation library used for the flatbed cannot drive duplex on
// this driver (Transfer fails with E_INVALIDARG / E_OUTOFMEMORY), but WIA 2.0
// IWiaTransfer::Download feeds the whole stack in one call and hands back one
// stream per page: side 1, side 2, side 1, side 2... Each finished page is
// cropped straight away and reported as a JSON line on stdout, so the app can
// start on the first card while the rest of the stack is still feeding.
public static class CollectorsHubWiaFeed
{
    [ComImport, Guid("79C07CF1-CBDD-41ee-8EC3-F00080CADA7A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IWiaDevMgr2
    {
        [PreserveSig] int EnumDeviceInfo(int lFlags, out IntPtr ppIEnum);
        [PreserveSig] int CreateDevice(int lFlags, [MarshalAs(UnmanagedType.BStr)] string bstrDeviceID, out IWiaItem2 ppWiaItem2Root);
    }

    [ComImport, Guid("6CBA0075-1287-407d-9B77-CF0E030435CC"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IWiaItem2
    {
        [PreserveSig] int CreateChildItem(int lItemFlags, int lCreationFlags, [MarshalAs(UnmanagedType.BStr)] string name, out IntPtr item);
        [PreserveSig] int DeleteItem(int lFlags);
        [PreserveSig] int EnumChildItems(IntPtr pCategoryGUID, out IEnumWiaItem2 ppEnum);
        [PreserveSig] int FindItemByName(int lFlags, [MarshalAs(UnmanagedType.BStr)] string name, out IWiaItem2 item);
        [PreserveSig] int GetItemCategory(out Guid category);
    }

    [ComImport, Guid("59970AF4-CD0D-44d9-AB24-52295630E582"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IEnumWiaItem2
    {
        [PreserveSig] int Next(uint cElt, out IWiaItem2 item, out uint fetched);
    }

    [ComImport, Guid("98B5E8A0-29CC-491a-AAC0-E6DB4FDCCEB6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IWiaPropertyStorage
    {
        [PreserveSig] int ReadMultiple(uint cpspec, IntPtr rgpspec, IntPtr rgpropvar);
        [PreserveSig] int WriteMultiple(uint cpspec, IntPtr rgpspec, IntPtr rgpropvar, uint propidNameFirst);
    }

    [ComImport, Guid("c39d6942-2f4e-4d04-92fe-4ef4d3a1de5a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IWiaTransfer
    {
        [PreserveSig] int Download(int lFlags, IWiaTransferCallback callback);
    }

    [ComImport, Guid("27d4eaaf-28a6-4ca5-9aab-e678168b9527"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IWiaTransferCallback
    {
        [PreserveSig] int TransferCallback(int lFlags, IntPtr pWiaTransferParams);
        [PreserveSig] int GetNextStream(int lFlags, [MarshalAs(UnmanagedType.BStr)] string itemName, [MarshalAs(UnmanagedType.BStr)] string fullItemName, out ComIStream stream);
    }

    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateStreamOnFileEx(string file, uint mode, uint attributes, bool create, ComIStream template, out ComIStream stream);

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(IntPtr pvar);

    static readonly Guid CLSID_WiaDevMgr2 = new Guid("B6C292BC-7C88-41ee-8B54-8EC92617E599");
    static readonly Guid CATEGORY_FEEDER = new Guid("FE131934-F84C-42AD-8DA4-6129CDDD7288");

    // Property ids.
    const int WIA_IPS_DOCUMENT_HANDLING_SELECT = 3088, WIA_IPS_PAGES = 3096, WIA_IPA_DATATYPE = 4103;
    const int WIA_IPS_CUR_INTENT = 6146, WIA_IPS_XRES = 6147, WIA_IPS_YRES = 6148;
    const int WIA_IPS_XPOS = 6149, WIA_IPS_YPOS = 6150, WIA_IPS_XEXTENT = 6151, WIA_IPS_YEXTENT = 6152;
    const int DUPLEX = 0x4, FRONT_ONLY = 0x20, ALL_PAGES = 0, WIA_DATA_COLOR = 3, WIA_INTENT_IMAGE_TYPE_COLOR = 1;
    // Transfer callback messages.
    const int MSG_END_OF_STREAM = 2, MSG_END_OF_TRANSFER = 3, MSG_DEVICE_STATUS = 5;

    static readonly int PropVariantSize = IntPtr.Size == 8 ? 24 : 16;
    static readonly int PropSpecSize = IntPtr.Size == 8 ? 16 : 8;

    static IntPtr Zeroed(int size)
    {
        IntPtr p = Marshal.AllocCoTaskMem(size);
        for (int i = 0; i < size; i++) Marshal.WriteByte(p, i, 0);
        return p;
    }

    static IntPtr SpecFor(int propId)
    {
        IntPtr spec = Zeroed(PropSpecSize);
        Marshal.WriteInt32(spec, 0, 1); // PRSPEC_PROPID
        Marshal.WriteInt32(spec, IntPtr.Size, propId);
        return spec;
    }

    static int? ReadInt(object item, int propId)
    {
        IntPtr spec = SpecFor(propId), pv = Zeroed(PropVariantSize);
        try
        {
            if (((IWiaPropertyStorage)item).ReadMultiple(1, spec, pv) != 0) return null;
            short vt = Marshal.ReadInt16(pv, 0);
            int? value = vt == 3 || vt == 19 || vt == 22 ? Marshal.ReadInt32(pv, 8) : (int?)null;
            PropVariantClear(pv);
            return value;
        }
        finally { Marshal.FreeCoTaskMem(spec); Marshal.FreeCoTaskMem(pv); }
    }

    static int WriteInt(object item, int propId, int value)
    {
        IntPtr spec = SpecFor(propId), pv = Zeroed(PropVariantSize);
        try
        {
            Marshal.WriteInt16(pv, 0, 3); // VT_I4
            Marshal.WriteInt32(pv, 8, value);
            return ((IWiaPropertyStorage)item).WriteMultiple(1, spec, pv, 2);
        }
        finally { Marshal.FreeCoTaskMem(spec); Marshal.FreeCoTaskMem(pv); }
    }

    static IWiaItem2 FindFeeder(IWiaItem2 item)
    {
        Guid category;
        item.GetItemCategory(out category);
        if (category == CATEGORY_FEEDER) return item;
        IEnumWiaItem2 children;
        if (item.EnumChildItems(IntPtr.Zero, out children) != 0 || children == null) return null;
        while (true)
        {
            IWiaItem2 child; uint fetched;
            if (children.Next(1, out child, out fetched) != 0 || fetched == 0) return null;
            var found = FindFeeder(child);
            if (found != null) return found;
        }
    }

    static void Emit(string json)
    {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }

    static string Quote(string value)
    {
        return "\"" + (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    class Callback : IWiaTransferCallback
    {
        public string RequestId, OutDir, CancelPath;
        public int Dpi;
        public int Pages;
        public List<string> DeviceMessages = new List<string>();
        public System.Diagnostics.Stopwatch Watch;
        ComIStream current;
        string currentPath;

        // Pages are cropped and saved on a worker thread: the driver waits for
        // this callback to return before feeding the next card, so doing the
        // work here held the FastFoto up after its buffer (the first card or
        // two) filled. At most MaxWaiting pages wait, so a slow computer
        // can't fill the disk with raw page files.
        const int MaxWaiting = 6;
        readonly System.Collections.Concurrent.BlockingCollection<string[]> waiting = new System.Collections.Concurrent.BlockingCollection<string[]>(MaxWaiting);
        System.Threading.Thread worker;

        public void StartWorker()
        {
            worker = new System.Threading.Thread(() =>
            {
                foreach (var job in waiting.GetConsumingEnumerable()) ProcessPage(job[0], int.Parse(job[1]), job[2]);
            });
            worker.IsBackground = true;
            worker.Start();
        }

        // After the last page: waits for the worker to finish the rest.
        public void FinishWorker()
        {
            waiting.CompleteAdding();
            if (worker != null) worker.Join();
        }

        public int TransferCallback(int lFlags, IntPtr p)
        {
            int message = Marshal.ReadInt32(p, 0);
            int hr = Marshal.ReadInt32(p, 16);
            if (message == MSG_END_OF_STREAM || message == MSG_END_OF_TRANSFER) FinishPage();
            if (message == MSG_DEVICE_STATUS && hr != 0) DeviceMessages.Add("0x" + hr.ToString("X8"));
            // S_FALSE cancels the transfer after the current page.
            return CancelPath != null && File.Exists(CancelPath) ? 1 : 0;
        }

        public int GetNextStream(int lFlags, string itemName, string fullItemName, out ComIStream stream)
        {
            FinishPage();
            currentPath = Path.Combine(OutDir, DateTime.UtcNow.Ticks + "-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".bmp");
            // STGM_CREATE | STGM_READWRITE | STGM_SHARE_EXCLUSIVE
            SHCreateStreamOnFileEx(currentPath, 0x1000 | 0x2 | 0x10, 0x80, true, null, out stream);
            current = stream;
            return 0;
        }

        // Closes the finished page's stream and hands it to the worker. The
        // driver ends the stack with an empty stream, which is discarded.
        public void FinishPage()
        {
            if (current == null) return;
            Marshal.ReleaseComObject(current);
            current = null;
            string bmp = currentPath;
            currentPath = null;
            if (!File.Exists(bmp)) return;
            if (new FileInfo(bmp).Length < 4096) { File.Delete(bmp); return; }
            Pages++;
            string receivedMs = Watch == null ? "0" : Watch.ElapsedMilliseconds.ToString();
            waiting.Add(new[] { bmp, Pages.ToString(), receivedMs });
        }

        // Crops a page and reports it (on the worker thread, in page order).
        void ProcessPage(string bmp, int page, string receivedMs)
        {
            string stem = bmp.Substring(0, bmp.Length - 4);
            string master = stem + ".png", raw = stem + ".raw.jpg";
            string json;
            try { json = CollectorsHubScanCrop.ProcessFeedPage(bmp, raw, master, Dpi); }
            catch (Exception error) { json = "{\"status\":\"error\",\"error\":" + Quote(error.Message) + "}"; }
            try { File.Delete(bmp); } catch { }
            string doneMs = Watch == null ? "0" : Watch.ElapsedMilliseconds.ToString();
            Emit("{\"id\":" + Quote(RequestId) + ",\"event\":\"page\",\"page\":" + page + ",\"path\":" + Quote(master) + ",\"rawPath\":" + Quote(raw) + ",\"receivedMs\":" + receivedMs + ",\"doneMs\":" + doneMs + ",\"crop\":" + json + "}");
        }
    }

    // Feeds every loaded card (both sides) and returns a JSON summary. The
    // scan area is a strip centred on the feeder (cards feed centre-aligned).
    public static string Feed(string requestId, string deviceId, string outDir, string cancelPath, int dpi, double widthIn, double heightIn, bool duplex)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var manager = (IWiaDevMgr2)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_WiaDevMgr2));
        IWiaItem2 root;
        int hr = manager.CreateDevice(0, deviceId, out root);
        if (hr != 0) return "{\"ok\":false,\"code\":\"NO_DEVICE\",\"hresult\":\"0x" + hr.ToString("X8") + "\"}";
        var feeder = FindFeeder(root);
        if (feeder == null) return "{\"ok\":false,\"code\":\"NO_FEEDER\"}";

        var rejected = new List<string>();
        Action<string, int, int> set = (name, id, value) => { int r = WriteInt(feeder, id, value); if (r != 0) rejected.Add(name + "=0x" + r.ToString("X8")); };
        set("handling", WIA_IPS_DOCUMENT_HANDLING_SELECT, duplex ? DUPLEX : FRONT_ONLY);
        set("pages", WIA_IPS_PAGES, ALL_PAGES);
        set("intent", WIA_IPS_CUR_INTENT, WIA_INTENT_IMAGE_TYPE_COLOR);
        set("datatype", WIA_IPA_DATATYPE, WIA_DATA_COLOR);
        set("xres", WIA_IPS_XRES, dpi);
        set("yres", WIA_IPS_YRES, dpi);
        // Page width in pixels at this resolution (the driver reports the
        // maximum extent once the resolution is set).
        int maxW = ReadInt(feeder, WIA_IPS_XEXTENT) ?? (int)(8.5 * dpi);
        int w = Math.Min(maxW, (int)Math.Round(widthIn * dpi)), h = (int)Math.Round(heightIn * dpi);
        int x = Math.Max(0, (maxW - w) / 2);
        set("xextent", WIA_IPS_XEXTENT, w);
        set("yextent", WIA_IPS_YEXTENT, h);
        set("xpos", WIA_IPS_XPOS, x);
        set("ypos", WIA_IPS_YPOS, 0);
        set("xextent", WIA_IPS_XEXTENT, w);
        set("yextent", WIA_IPS_YEXTENT, h);

        Directory.CreateDirectory(outDir);
        var callback = new Callback { RequestId = requestId, OutDir = outDir, CancelPath = cancelPath, Dpi = dpi, Watch = watch };
        callback.StartWorker();
        int result;
        try
        {
            result = ((IWiaTransfer)feeder).Download(0, callback);
            callback.FinishPage();
        }
        finally
        {
            callback.FinishWorker();
        }
        bool cancelled = cancelPath != null && File.Exists(cancelPath);
        return "{\"ok\":" + (result == 0 || result == 1 ? "true" : "false")
            + ",\"hresult\":\"0x" + result.ToString("X8") + "\""
            + ",\"pages\":" + callback.Pages
            + ",\"cancelled\":" + (cancelled ? "true" : "false")
            + ",\"region\":{\"x\":" + x + ",\"w\":" + w + ",\"h\":" + h + "}"
            + ",\"rejected\":[" + string.Join(",", rejected.ConvertAll(Quote)) + "]"
            + ",\"deviceMessages\":[" + string.Join(",", callback.DeviceMessages.ConvertAll(Quote)) + "]"
            + ",\"totalMs\":" + watch.ElapsedMilliseconds + "}";
    }
}
