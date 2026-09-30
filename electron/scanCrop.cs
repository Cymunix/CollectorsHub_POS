using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class CollectorsHubScanCrop
{
    // Skew (degrees) corrected on the last crop; 0 when none applied.
    public static double LastSkewDegrees = 0;
    // Crop rectangle chosen by the last general (full-bed) crop.
    public static Rectangle LastCropRect = Rectangle.Empty;

    // Standard trading card: 2.5 x 3.5 in (5:7). Used only as a validation
    // signal and for the final crop size, never to cut into a detected card.
    const double CardWidthIn = 2.5;
    const double CardHeightIn = 3.5;
    const double CardAspect = CardWidthIn / CardHeightIn;
    const double FinalMarginIn = 0.03;

    // One entry point for the scanner session. Keeps the raw scan, applies the
    // card region in software when the driver ignored the requested hardware
    // region, then crops by mode. Returns a JSON object (for logging and UI).
    //   mode "card": fixed standard-card region, geometry-validated crop
    //   mode "full": whole bed, general object detection
    public static string ProcessScan(string source, string rawPath, string outputPath, string displayPath, long quality, string mode, int dpi,
        int roiX, int roiY, int roiW, int roiH, bool roiApplied)
    {
        string result = ProcessScanCore(source, rawPath, outputPath, quality, mode, dpi, roiX, roiY, roiW, roiH, roiApplied);
        if (string.IsNullOrEmpty(displayPath)) return result;
        try
        {
            string display = SaveDisplayCopy(outputPath, displayPath);
            return result.Substring(0, result.Length - 1) + "," + display.Substring(1);
        }
        catch (Exception error)
        {
            return result.Substring(0, result.Length - 1) + "," + Json("displayError", error.Message).Substring(1);
        }
    }

    // Optional display copy, separate from the faithful master: a mild levels
    // stretch only. Black/white points move at most 12 levels and only past the
    // 0.1% / 99.9% luminance percentiles, so shadow detail in dark jerseys,
    // black borders and foil is never crushed to pure black.
    static string SaveDisplayCopy(string masterPath, string displayPath)
    {
        using (var master = new Bitmap(masterPath))
        {
            int width = master.Width, height = master.Height;
            var histogram = new long[256];
            long samples = 0;
            int step = Math.Max(1, Math.Min(width, height) / 600);
            var data = master.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                var line = new byte[width * 3];
                for (int y = 0; y < height; y += step)
                {
                    Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), line, 0, line.Length);
                    for (int x = 0; x < width; x += step)
                    {
                        int luma = (line[x * 3 + 2] * 299 + line[x * 3 + 1] * 587 + line[x * 3] * 114) / 1000;
                        histogram[luma]++;
                        samples++;
                    }
                }
            }
            finally { master.UnlockBits(data); }
            int low = 0, high = 255;
            long cumulative = 0;
            for (int i = 0; i < 256; i++) { cumulative += histogram[i]; if (cumulative >= samples * 0.001) { low = i; break; } }
            cumulative = 0;
            for (int i = 255; i >= 0; i--) { cumulative += histogram[i]; if (cumulative >= samples * 0.001) { high = i; break; } }
            int blackPoint = Math.Min(low, 12);
            int whitePoint = Math.Max(high, 243);
            var lut = new byte[256];
            for (int i = 0; i < 256; i++)
            {
                double value = (i - blackPoint) * 255.0 / Math.Max(1, whitePoint - blackPoint);
                lut[i] = (byte)Math.Max(0, Math.Min(255, Math.Round(value)));
            }
            using (var copy = master.Clone(new Rectangle(0, 0, width, height), PixelFormat.Format24bppRgb))
            {
                var bits = copy.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadWrite, PixelFormat.Format24bppRgb);
                try
                {
                    var row = new byte[width * 3];
                    for (int y = 0; y < height; y++)
                    {
                        IntPtr pointer = IntPtr.Add(bits.Scan0, y * bits.Stride);
                        Marshal.Copy(pointer, row, 0, row.Length);
                        for (int i = 0; i < row.Length; i++) row[i] = lut[row[i]];
                        Marshal.Copy(row, 0, pointer, row.Length);
                    }
                }
                finally { copy.UnlockBits(bits); }
                SaveImage(copy, displayPath, 92);
            }
            return Json("displayBlackPoint", blackPoint, "displayWhitePoint", whitePoint, "shadowPercentile", low, "highlightPercentile", high);
        }
    }

    static string ProcessScanCore(string source, string rawPath, string outputPath, long quality, string mode, int dpi,
        int roiX, int roiY, int roiW, int roiH, bool roiApplied)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        LastSkewDegrees = 0;
        LastCropRect = Rectangle.Empty;
        using (var bitmap = new Bitmap(source))
        {
            int returnedW = bitmap.Width, returnedH = bitmap.Height;
            if (!string.IsNullOrEmpty(rawPath)) SaveImage(bitmap, rawPath, 95);
            long rawMs = watch.ElapsedMilliseconds;
            watch.Restart();

            if (mode != "card")
            {
                bool cropped = SaveCroppedBitmap(bitmap, outputPath, quality);
                var r = LastCropRect;
                return Json(
                    "status", cropped ? "ok" : "no_object",
                    "returnedWidth", returnedW, "returnedHeight", returnedH,
                    "cropX", r.X, "cropY", r.Y, "cropWidth", r.Width, "cropHeight", r.Height,
                    "aspect", r.Height > 0 ? Math.Round((double)r.Width / r.Height, 4) : 0,
                    "skewDegrees", Math.Round(LastSkewDegrees, 2),
                    "cropped", cropped, "softwareRoi", false,
                    "rawSaveMs", rawMs, "cropMs", watch.ElapsedMilliseconds);
            }

            // Driver ignored the hardware region: cut the same region in software.
            bool softwareRoi = false;
            Bitmap region = bitmap;
            if (!roiApplied && roiW > 0 && roiH > 0)
            {
                var rect = Rectangle.Intersect(new Rectangle(0, 0, bitmap.Width, bitmap.Height), new Rectangle(roiX, roiY, roiW, roiH));
                if (rect.Width > 0 && rect.Height > 0 && (rect.Width < bitmap.Width || rect.Height < bitmap.Height))
                {
                    region = bitmap.Clone(rect, PixelFormat.Format24bppRgb);
                    softwareRoi = true;
                }
            }
            try
            {
                string card = CropStandardCard(region, dpi, outputPath, quality);
                return card.Substring(0, card.Length - 1) + "," + Json(
                    "returnedWidth", returnedW, "returnedHeight", returnedH,
                    "softwareRoi", softwareRoi, "rawSaveMs", rawMs, "cropMs", watch.ElapsedMilliseconds).Substring(1);
            }
            finally
            {
                if (region != bitmap) region.Dispose();
            }
        }
    }

    // Standard-card crop inside the already-restricted card region:
    // 1. straighten, 2. find the printed card content, 3. validate against the
    // 5:7 geometry and the expected size at this DPI, 4. crop to the full card
    // size around the content plus a small margin. When the evidence is weak the
    // whole region is kept, so the crop never cuts into the card.
    static string CropStandardCard(Bitmap region, int dpi, string outputPath, long quality)
    {
        int expectedW = (int)Math.Round(CardWidthIn * dpi), expectedH = (int)Math.Round(CardHeightIn * dpi);
        double targetAspect = CardAspect;
        string orientation = "portrait";
        Bitmap straight = region;
        double skew = 0;
        try { skew = EstimateSkew(region, new Rectangle(0, 0, region.Width, region.Height)); } catch { skew = 0; }
        if (Math.Abs(skew) >= 0.3 && Math.Abs(skew) <= 8) straight = Rotate(region, -skew);
        else skew = 0;
        LastSkewDegrees = skew;
        try
        {
            int[] content = null;
            // The region holds exactly one card, so white gaps inside the card (e.g.
            // between a card-back title and its bio text) are bridged generously, and a
            // row/column needs 5% content so the thin black bed-frame strip is ignored.
            try { content = FindContent(straight, 0.25, 0.05); } catch { content = null; }
            string status;
            double confidence = 0;
            Rectangle crop = new Rectangle(0, 0, straight.Width, straight.Height);
            int cw = 0, ch = 0;
            if (content == null)
            {
                status = "no_card";
            }
            else
            {
                cw = content[1] - content[0];
                ch = content[3] - content[2];
                // Portrait 2.5 x 3.5 or landscape 3.5 x 2.5, by the content's shape.
                if (cw > ch)
                {
                    int swap = expectedW; expectedW = expectedH; expectedH = swap;
                    targetAspect = 1 / CardAspect;
                    orientation = "landscape";
                }
                double ratio = ch > 0 ? (double)cw / ch : 0;
                double fillW = Math.Min(1.0, (double)cw / expectedW);
                double fillH = Math.Min(1.0, (double)ch / expectedH);
                double ratioError = Math.Abs(ratio - targetAspect) / targetAspect;
                // Size agreement dominates; aspect agreement confirms it. A crop
                // around roughly half the card (an internal box) scores low.
                confidence = Math.Round(0.6 * Math.Min(fillW, fillH) + 0.4 * Math.Max(0, 1 - ratioError * 3), 2);
                // A card in the region touches at most the two edges of its corner;
                // content spanning opposite edges continues beyond the region.
                int edge = Math.Max(2, straight.Width / 100);
                bool spansWidth = content[0] <= edge && content[1] >= straight.Width - 1 - edge;
                bool spansHeight = content[2] <= edge && content[3] >= straight.Height - 1 - edge;
                if (cw > expectedW * 1.08 || ch > expectedH * 1.08 || spansWidth || spansHeight)
                {
                    // Larger than a standard card in either orientation: not this mode.
                    status = "oversize";
                    confidence = Math.Min(confidence, 0.3);
                }
                else if (fillW < 0.75 || fillH < 0.75)
                {
                    // Only part of a card was found (e.g. an inner artwork box):
                    // keep the whole card region instead of cropping into it.
                    status = "low_confidence";
                }
                else
                {
                    status = "ok";
                    int cardW = Math.Max(cw, expectedW), cardH = Math.Max(ch, expectedH);
                    int centerX = (content[0] + content[1]) / 2, centerY = (content[2] + content[3]) / 2;
                    // Slide (never clip) the full card size to stay inside the region,
                    // so a short printed block (e.g. a card back whose logo strip is
                    // separate) still yields a whole card.
                    int x0 = Clamp(centerX - cardW / 2, 0, Math.Max(0, straight.Width - cardW));
                    int y0 = Clamp(centerY - cardH / 2, 0, Math.Max(0, straight.Height - cardH));
                    int margin = (int)Math.Round(FinalMarginIn * dpi);
                    crop = Rectangle.Intersect(new Rectangle(0, 0, straight.Width, straight.Height),
                        new Rectangle(x0 - margin, y0 - margin, cardW + margin * 2, cardH + margin * 2));
                }
            }
            if (crop.Width == straight.Width && crop.Height == straight.Height) SaveImage(straight, outputPath, quality);
            else using (var cropped = straight.Clone(crop, PixelFormat.Format24bppRgb)) SaveImage(cropped, outputPath, quality);
            return Json(
                "status", status, "confidence", confidence, "orientation", orientation,
                "expectedWidth", expectedW, "expectedHeight", expectedH,
                "contentX", content == null ? 0 : content[0], "contentY", content == null ? 0 : content[2],
                "contentWidth", cw, "contentHeight", ch,
                "cropX", crop.X, "cropY", crop.Y, "cropWidth", crop.Width, "cropHeight", crop.Height,
                "aspect", crop.Height > 0 ? Math.Round((double)crop.Width / crop.Height, 4) : 0,
                "skewDegrees", Math.Round(skew, 2),
                "cropped", status == "ok");
        }
        finally
        {
            if (straight != region) straight.Dispose();
        }
    }

    static int Clamp(int value, int min, int max)
    {
        return value < min ? min : value > max ? max : value;
    }

    // Rotates the whole (small) card-region image about its centre on white.
    static Bitmap Rotate(Bitmap source, double degrees)
    {
        var result = new Bitmap(source.Width, source.Height, PixelFormat.Format24bppRgb);
        result.SetResolution(source.HorizontalResolution, source.VerticalResolution);
        using (var graphics = Graphics.FromImage(result))
        {
            graphics.Clear(Color.White);
            graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            graphics.TranslateTransform(source.Width / 2f, source.Height / 2f);
            graphics.RotateTransform((float)degrees);
            graphics.TranslateTransform(-source.Width / 2f, -source.Height / 2f);
            graphics.DrawImage(source, new Rectangle(0, 0, source.Width, source.Height));
        }
        return result;
    }

    // Minimal JSON object writer (invariant culture) for key/value pairs.
    static string Json(params object[] pairs)
    {
        var builder = new System.Text.StringBuilder("{");
        for (int i = 0; i + 1 < pairs.Length; i += 2)
        {
            if (i > 0) builder.Append(',');
            builder.Append('"').Append(pairs[i]).Append("\":");
            object value = pairs[i + 1];
            if (value is string) builder.Append('"').Append(((string)value).Replace("\\", "\\\\").Replace("\"", "\\\"")).Append('"');
            else if (value is bool) builder.Append((bool)value ? "true" : "false");
            else builder.Append(Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture));
        }
        return builder.Append('}').ToString();
    }

    // Saves the scan as a JPEG, deskewed and cropped to the card when one is
    // found. Any failure falls back to a simpler result (crop without deskew,
    // then the full scan) so a good acquisition is never lost.
    public static bool SaveCropped(string source, string destination, long quality)
    {
        LastSkewDegrees = 0;
        LastCropRect = Rectangle.Empty;
        using (var bitmap = new Bitmap(source)) return SaveCroppedBitmap(bitmap, destination, quality);
    }

    static bool SaveCroppedBitmap(Bitmap bitmap, string destination, long quality)
    {
        {
            Rectangle? crop = null;
            try { crop = FindCardBounds(bitmap); } catch { crop = null; }
            if (crop.HasValue)
            {
                try
                {
                    if (TrySaveDeskewed(bitmap, crop.Value, destination, quality)) return true;
                }
                catch { LastSkewDegrees = 0; }
                try
                {
                    using (var cropped = bitmap.Clone(crop.Value, PixelFormat.Format24bppRgb))
                    {
                        SaveImage(cropped, destination, quality);
                        LastCropRect = crop.Value;
                        return true;
                    }
                }
                catch { }
            }
            SaveImage(bitmap, destination, quality);
            LastCropRect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
            return false;
        }
    }

    // Straightens a card placed at a slight angle. Only the region around the
    // card is rotated (fast, and a card in a corner is never pushed out of
    // frame); then the card is found again in the straightened region.
    static bool TrySaveDeskewed(Bitmap bitmap, Rectangle cardRegion, string destination, long quality)
    {
        double skew = EstimateSkew(bitmap, cardRegion);
        if (Math.Abs(skew) < 0.3 || Math.Abs(skew) > 8) return false;

        int grow = (int)(Math.Max(cardRegion.Width, cardRegion.Height) * 0.08);
        var region = Rectangle.Intersect(new Rectangle(0, 0, bitmap.Width, bitmap.Height),
            new Rectangle(cardRegion.X - grow, cardRegion.Y - grow, cardRegion.Width + grow * 2, cardRegion.Height + grow * 2));
        using (var part = bitmap.Clone(region, PixelFormat.Format24bppRgb))
        using (var straight = new Bitmap(part.Width, part.Height, PixelFormat.Format24bppRgb))
        {
            straight.SetResolution(bitmap.HorizontalResolution, bitmap.VerticalResolution);
            using (var graphics = Graphics.FromImage(straight))
            {
                graphics.Clear(Color.White);
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                graphics.TranslateTransform(part.Width / 2f, part.Height / 2f);
                graphics.RotateTransform((float)-skew);
                graphics.TranslateTransform(-part.Width / 2f, -part.Height / 2f);
                graphics.DrawImage(part, new Rectangle(0, 0, part.Width, part.Height));
            }
            Rectangle? tight = null;
            try { tight = FindCardBounds(straight); } catch { tight = null; }
            if (tight.HasValue)
            {
                using (var cropped = straight.Clone(tight.Value, PixelFormat.Format24bppRgb)) SaveImage(cropped, destination, quality);
                LastCropRect = new Rectangle(region.X + tight.Value.X, region.Y + tight.Value.Y, tight.Value.Width, tight.Value.Height);
            }
            else
            {
                SaveImage(straight, destination, quality);
                LastCropRect = region;
            }
        }
        LastSkewDegrees = skew;
        return true;
    }

    // Estimates the card's skew in degrees (the correction is a rotation by the
    // negative of this) with a projection profile: the card's dark/coloured
    // pixels are rotated through candidate angles, and the angle where their
    // row and column histograms are sharpest wins. Printed boxes, text lines
    // and borders are rectangular, so this works whatever the card design, and
    // a white border on a white scanner bed does not matter.
    static double EstimateSkew(Bitmap bitmap, Rectangle region)
    {
        int width = bitmap.Width, height = bitmap.Height;
        int step = Math.Max(1, Math.Min(region.Width, region.Height) / 400);
        var xs = new System.Collections.Generic.List<float>();
        var ys = new System.Collections.Generic.List<float>();
        float cx = region.Left + region.Width / 2f, cy = region.Top + region.Height / 2f;
        var data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            var line = new byte[width * 3];
            for (int y = region.Top; y < region.Bottom; y += step)
            {
                Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), line, 0, line.Length);
                for (int x = region.Left; x < region.Right; x += step)
                {
                    int b = line[x * 3], g = line[x * 3 + 1], r = line[x * 3 + 2];
                    // Dark pixels only: text, lines and box edges carry the
                    // alignment; large pale areas would just blur the profile.
                    if (r + g + b < 360) { xs.Add(x - cx); ys.Add(y - cy); }
                }
            }
        }
        finally { bitmap.UnlockBits(data); }
        if (xs.Count < 500) return 0;

        int diagonal = (int)Math.Sqrt((double)region.Width * region.Width + (double)region.Height * region.Height) / step + 4;
        var rowBins = new int[diagonal];
        var colBins = new int[diagonal];
        Func<double, double> score = (degrees) =>
        {
            double radians = degrees * Math.PI / 180, cos = Math.Cos(radians), sin = Math.Sin(radians);
            Array.Clear(rowBins, 0, rowBins.Length);
            Array.Clear(colBins, 0, colBins.Length);
            int half = diagonal / 2;
            for (int i = 0; i < xs.Count; i++)
            {
                // Rotate each point by the candidate correction.
                double rx = xs[i] * cos - ys[i] * sin;
                double ry = xs[i] * sin + ys[i] * cos;
                int col = (int)(rx / step) + half, row = (int)(ry / step) + half;
                if (col >= 0 && col < diagonal) colBins[col]++;
                if (row >= 0 && row < diagonal) rowBins[row]++;
            }
            double total = 0;
            for (int i = 0; i < diagonal; i++) total += (double)rowBins[i] * rowBins[i] + (double)colBins[i] * colBins[i];
            return total;
        };

        double best = 0, bestScore = score(0), zeroScore = bestScore;
        for (double degrees = -8; degrees <= 8.001; degrees += 0.5)
        {
            double value = score(degrees);
            if (value > bestScore) { bestScore = value; best = degrees; }
        }
        double coarse = best;
        for (double degrees = coarse - 0.5; degrees <= coarse + 0.501; degrees += 0.1)
        {
            double value = score(degrees);
            if (value > bestScore) { bestScore = value; best = degrees; }
        }
        // Only trust a clear improvement over "already straight".
        if (bestScore < zeroScore * 1.004) return 0;
        return -best;
    }

    // Saves by extension: .png is lossless (masters and raw scans, so dark areas
    // and gradients are never re-compressed); anything else is JPEG.
    static void SaveImage(Image image, string path, long quality)
    {
        if (path.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
        {
            image.Save(path, ImageFormat.Png);
            return;
        }
        ImageCodecInfo codec = null;
        foreach (var candidate in ImageCodecInfo.GetImageEncoders())
        {
            if (candidate.FormatID == ImageFormat.Jpeg.Guid) codec = candidate;
        }
        using (var parameters = new EncoderParameters(1))
        {
            parameters.Param[0] = new EncoderParameter(Encoder.Quality, quality);
            image.Save(path, codec, parameters);
        }
    }

    // Find the densest block of non-white content. No fixed edge margin: cards
    // are often placed flush in a corner of the bed. The TS3725's black frame
    // strip is thin, so it never outweighs the card and is kept out of the
    // padding by PadOutward.
    static Rectangle? FindCardBounds(Bitmap bitmap)
    {
        int width = bitmap.Width, height = bitmap.Height;
        if (width < 100 || height < 100) return null;
        int step = Math.Max(1, Math.Min(width, height) / 1000);
        var cols = new int[width];
        var rows = new int[height];
        int sampledRows = 0, sampledCols = 0;
        for (int x = 0; x < width; x += step) sampledCols++;

        var data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            var line = new byte[width * 3];
            for (int y = 0; y < height; y += step)
            {
                sampledRows++;
                Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), line, 0, line.Length);
                for (int x = 0; x < width; x += step)
                {
                    int b = line[x * 3], g = line[x * 3 + 1], r = line[x * 3 + 2];
                    int spread = Math.Max(r, Math.Max(g, b)) - Math.Min(r, Math.Min(g, b));
                    if (r + g + b < 705 || spread > 44) { cols[x]++; rows[y]++; }
                }
            }
        }
        finally { bitmap.UnlockBits(data); }

        int colThreshold = Math.Max(3, (int)(sampledRows * 0.018));
        int rowThreshold = Math.Max(3, (int)(sampledCols * 0.018));
        // Bridge white gaps inside one item (a card back can have ~0.3 in of
        // white between its title and bio text) while keeping separate items apart.
        int[] xRange = DensestRun(cols, width, step, colThreshold, Math.Max(step * 2, width / 25));
        int[] yRange = DensestRun(rows, height, step, rowThreshold, Math.Max(step * 2, height / 25));
        if (xRange == null || yRange == null) return null;

        int contentWidth = xRange[1] - xRange[0], contentHeight = yRange[1] - yRange[0];
        double contentArea = (double)contentWidth * contentHeight, imageArea = (double)width * height;
        if (contentWidth <= 80 || contentHeight <= 80 || contentArea <= imageArea * 0.01 || contentArea >= imageArea * 0.92) return null;

        // Padding recovers a white card border that reads as "background".
        int pad = Math.Max(24, (int)(Math.Max(contentWidth, contentHeight) * 0.065));
        int left = PadOutward(cols, xRange[0], -step, pad, colThreshold, width);
        int right = PadOutward(cols, xRange[1], step, pad, colThreshold, width);
        int top = PadOutward(rows, yRange[0], -step, pad, rowThreshold, height);
        int bottom = PadOutward(rows, yRange[1], step, pad, rowThreshold, height);
        return new Rectangle(left, top, right - left + 1, bottom - top + 1);
    }

    // Raw printed-content extent { left, right, top, bottom } (no padding, no
    // area limits): the densest block of non-background pixels. Used by the
    // standard-card crop, whose region is already constrained to one card.
    static int[] FindContent(Bitmap bitmap, double gapFraction, double thresholdFraction)
    {
        int width = bitmap.Width, height = bitmap.Height;
        if (width < 100 || height < 100) return null;
        int step = Math.Max(1, Math.Min(width, height) / 1000);
        var cols = new int[width];
        var rows = new int[height];
        int sampledRows = 0, sampledCols = 0;
        for (int x = 0; x < width; x += step) sampledCols++;
        var data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            var line = new byte[width * 3];
            for (int y = 0; y < height; y += step)
            {
                sampledRows++;
                Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), line, 0, line.Length);
                for (int x = 0; x < width; x += step)
                {
                    int b = line[x * 3], g = line[x * 3 + 1], r = line[x * 3 + 2];
                    int spread = Math.Max(r, Math.Max(g, b)) - Math.Min(r, Math.Min(g, b));
                    if (r + g + b < 705 || spread > 44) { cols[x]++; rows[y]++; }
                }
            }
        }
        finally { bitmap.UnlockBits(data); }
        int[] xRange = DensestRun(cols, width, step, Math.Max(3, (int)(sampledRows * thresholdFraction)), Math.Max(step * 2, (int)(width * gapFraction)));
        int[] yRange = DensestRun(rows, height, step, Math.Max(3, (int)(sampledCols * thresholdFraction)), Math.Max(step * 2, (int)(height * gapFraction)));
        if (xRange == null || yRange == null || xRange[1] - xRange[0] < 80 || yRange[1] - yRange[0] < 80) return null;
        return new[] { xRange[0], xRange[1], yRange[0], yRange[1] };
    }

    // Extends an edge outward by up to pad pixels, stopping before any separate dark
    // feature (the bed frame, another card) so it is not pulled into the crop.
    static int PadOutward(int[] counts, int edge, int direction, int pad, int threshold, int length)
    {
        int result = edge;
        for (int i = edge + direction; Math.Abs(i - edge) <= pad; i += direction)
        {
            if (i < 0 || i >= length || counts[i] >= threshold) break;
            result = i;
        }
        if (direction < 0) return Math.Max(0, result - Math.Abs(direction) + 1);
        return Math.Min(length - 1, result + direction - 1);
    }

    // Heaviest run of active positions, bridging gaps up to maxGap, so a stray
    // lid shadow or dust line cannot stretch the crop out to the scan edge.
    static int[] DensestRun(int[] counts, int length, int step, int threshold, int maxGap)
    {
        int[] best = null;
        long bestWeight = 0, weight = 0;
        int runStart = -1, runEnd = -1;
        for (int i = 0; i < length; i += step)
        {
            if (counts[i] < threshold) continue;
            if (runStart >= 0 && i - runEnd > maxGap)
            {
                if (weight > bestWeight) { best = new[] { runStart, runEnd }; bestWeight = weight; }
                runStart = -1;
                weight = 0;
            }
            if (runStart < 0) runStart = i;
            runEnd = i;
            weight += counts[i];
        }
        if (runStart >= 0 && weight > bestWeight) best = new[] { runStart, runEnd };
        return best;
    }

    // ---------------------------------------------------------------------
    // Sheet-fed pages (Epson FastFoto). The card passes over a uniform grey
    // background; after its trailing edge the driver pads the page with white.
    // Unlike the flatbed, the card's own edge is visible against the grey, so
    // the crop follows the physical card edge (white borders included).
    // Orientation (which way up) is decided later from the card's text.

    const int FeedDiffThreshold = 60;

    public static string ProcessFeedPage(string source, string rawPath, string outputPath, int dpi)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        using (var loaded = new Bitmap(source))
        using (var bitmap = loaded.Clone(new Rectangle(0, 0, loaded.Width, loaded.Height), PixelFormat.Format24bppRgb))
        {
            int width = bitmap.Width, height = bitmap.Height;
            if (!string.IsNullOrEmpty(rawPath)) SaveImage(bitmap, rawPath, 92);
            var pixels = ReadPixels(bitmap);
            int stride = width * 3;
            int margin = Math.Max(8, (int)(0.1 * dpi));
            int[] bg = FeedBackground(pixels, width, height, margin);

            // Rows where both side margins stop being grey are past the card's
            // trailing edge (white padding). Paint them grey so they are ignored.
            int padStart = height;
            int run = 0;
            for (int y = (int)(0.5 * dpi); y < height; y++)
            {
                int hits = 0, samples = 0;
                for (int x = 0; x < margin; x += 2) { samples++; if (IsForeground(pixels, y * stride + x * 3, bg)) hits++; }
                for (int x = width - margin; x < width; x += 2) { samples++; if (IsForeground(pixels, y * stride + x * 3, bg)) hits++; }
                if (hits >= samples * 0.9) { run++; if (run >= 8) { padStart = y - run + 1; break; } }
                else run = 0;
            }
            for (int y = padStart; y < height; y++) FillRow(pixels, y * stride, width, bg);

            double skew = FeedSkew(pixels, width, height, bg, dpi);
            Bitmap working = bitmap;
            bool rotated = false;
            if (Math.Abs(skew) >= 0.15 && Math.Abs(skew) <= 8)
            {
                WritePixels(bitmap, pixels);
                working = RotateOn(bitmap, skew, Color.FromArgb(bg[0], bg[1], bg[2]));
                pixels = ReadPixels(working);
                rotated = true;
            }
            else skew = 0;
            try
            {
                int[] box = FeedBounds(pixels, width, height, bg, dpi);
                string status;
                Rectangle crop = new Rectangle(0, 0, width, padStart);
                if (box == null) status = "no_card";
                else
                {
                    crop = Rectangle.FromLTRB(box[0], box[1], box[2] + 1, box[3] + 1);
                    double wIn = (double)crop.Width / dpi, hIn = (double)crop.Height / dpi;
                    bool touches = box[0] <= 2 || box[2] >= width - 3 || padStart >= height;
                    status = touches || Math.Max(wIn, hIn) > 3.9 ? "oversize" : Math.Min(wIn, hIn) < 1.5 ? "low_confidence" : "ok";
                    if (status == "low_confidence") crop = new Rectangle(0, 0, width, Math.Max(1, padStart));
                }
                using (var cropped = working.Clone(crop, PixelFormat.Format24bppRgb)) SaveImage(cropped, outputPath, 92);
                return Json(
                    "status", status,
                    "orientation", crop.Width > crop.Height ? "landscape" : "portrait",
                    "returnedWidth", width, "returnedHeight", height, "padStart", padStart,
                    "cropX", crop.X, "cropY", crop.Y, "cropWidth", crop.Width, "cropHeight", crop.Height,
                    "widthIn", Math.Round((double)crop.Width / dpi, 3), "heightIn", Math.Round((double)crop.Height / dpi, 3),
                    "skewDegrees", Math.Round(skew, 2),
                    "background", bg[0] + "," + bg[1] + "," + bg[2],
                    "cropped", status == "ok", "processMs", watch.ElapsedMilliseconds);
            }
            finally
            {
                if (rotated) working.Dispose();
            }
        }
    }

    static byte[] ReadPixels(Bitmap bitmap)
    {
        int width = bitmap.Width, height = bitmap.Height;
        var pixels = new byte[width * 3 * height];
        var data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try { for (int y = 0; y < height; y++) Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), pixels, y * width * 3, width * 3); }
        finally { bitmap.UnlockBits(data); }
        return pixels;
    }

    static void WritePixels(Bitmap bitmap, byte[] pixels)
    {
        int width = bitmap.Width, height = bitmap.Height;
        var data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
        try { for (int y = 0; y < height; y++) Marshal.Copy(pixels, y * width * 3, IntPtr.Add(data.Scan0, y * data.Stride), width * 3); }
        finally { bitmap.UnlockBits(data); }
    }

    // Median background colour (BGR) from both side margins near the top.
    static int[] FeedBackground(byte[] pixels, int width, int height, int margin)
    {
        var b = new System.Collections.Generic.List<int>();
        var g = new System.Collections.Generic.List<int>();
        var r = new System.Collections.Generic.List<int>();
        int stride = width * 3;
        for (int y = 2; y < Math.Min(height, margin * 6); y += 3)
        {
            for (int x = 2; x < margin; x += 3)
            {
                foreach (int px in new[] { x, width - 1 - x })
                {
                    int i = y * stride + px * 3;
                    b.Add(pixels[i]); g.Add(pixels[i + 1]); r.Add(pixels[i + 2]);
                }
            }
        }
        b.Sort(); g.Sort(); r.Sort();
        return new[] { b[b.Count / 2], g[g.Count / 2], r[r.Count / 2] };
    }

    static bool IsForeground(byte[] pixels, int i, int[] bg)
    {
        return Math.Abs(pixels[i] - bg[0]) + Math.Abs(pixels[i + 1] - bg[1]) + Math.Abs(pixels[i + 2] - bg[2]) > FeedDiffThreshold;
    }

    static void FillRow(byte[] pixels, int offset, int width, int[] bg)
    {
        for (int x = 0; x < width; x++) { pixels[offset + x * 3] = (byte)bg[0]; pixels[offset + x * 3 + 1] = (byte)bg[1]; pixels[offset + x * 3 + 2] = (byte)bg[2]; }
    }

    // First/last position along a line where 4 consecutive foreground pixels start.
    static int EdgeInRow(byte[] pixels, int width, int y, int[] bg, bool fromLeft)
    {
        int stride = width * 3, count = 0;
        for (int k = 0; k < width; k++)
        {
            int x = fromLeft ? k : width - 1 - k;
            if (IsForeground(pixels, y * stride + x * 3, bg)) { if (++count >= 4) return fromLeft ? x - 3 : x + 3; }
            else count = 0;
        }
        return -1;
    }

    static int EdgeInColumn(byte[] pixels, int width, int height, int x, int[] bg, bool fromTop)
    {
        int stride = width * 3, count = 0;
        for (int k = 0; k < height; k++)
        {
            int y = fromTop ? k : height - 1 - k;
            if (IsForeground(pixels, y * stride + x * 3, bg)) { if (++count >= 4) return fromTop ? y - 3 : y + 3; }
            else count = 0;
        }
        return -1;
    }

    // Card rows: rows whose foreground spans more than an inch.
    static int[] FeedRowRange(byte[] pixels, int width, int height, int[] bg, int dpi)
    {
        int top = -1, bottom = -1;
        for (int y = 0; y < height; y += 2)
        {
            int left = EdgeInRow(pixels, width, y, bg, true);
            if (left < 0) continue;
            int right = EdgeInRow(pixels, width, y, bg, false);
            if (right - left < dpi) continue;
            if (top < 0) top = y;
            bottom = y;
        }
        return top < 0 ? null : new[] { top, bottom };
    }

    // Skew (degrees, clockwise positive) from straight-line fits of the card's
    // left and right edges over the middle of the card.
    static double FeedSkew(byte[] pixels, int width, int height, int[] bg, int dpi)
    {
        var rows = FeedRowRange(pixels, width, height, bg, dpi);
        if (rows == null) return 0;
        int span = rows[1] - rows[0];
        if (span < dpi) return 0;
        var slopes = new System.Collections.Generic.List<double>();
        foreach (bool fromLeft in new[] { true, false })
        {
            var ys = new System.Collections.Generic.List<double>();
            var xs = new System.Collections.Generic.List<double>();
            for (int y = rows[0] + span / 5; y < rows[1] - span / 5; y += 4)
            {
                int x = EdgeInRow(pixels, width, y, bg, fromLeft);
                if (x >= 0) { ys.Add(y); xs.Add(x); }
            }
            if (ys.Count < 20) continue;
            double my = 0, mx = 0;
            for (int i = 0; i < ys.Count; i++) { my += ys[i]; mx += xs[i]; }
            my /= ys.Count; mx /= ys.Count;
            double num = 0, den = 0;
            for (int i = 0; i < ys.Count; i++) { num += (ys[i] - my) * (xs[i] - mx); den += (ys[i] - my) * (ys[i] - my); }
            if (den > 0) slopes.Add(num / den);
        }
        if (slopes.Count == 0) return 0;
        double slope = slopes.Count == 2 && Math.Abs(slopes[0] - slopes[1]) < 0.01 ? (slopes[0] + slopes[1]) / 2 : slopes[0];
        // x increases with y when the card leans clockwise; rotate back by that angle.
        return Math.Atan(slope) * 180 / Math.PI;
    }

    // Median edges over the middle of each side (rounded corners excluded).
    static int[] FeedBounds(byte[] pixels, int width, int height, int[] bg, int dpi)
    {
        var rows = FeedRowRange(pixels, width, height, bg, dpi);
        if (rows == null) return null;
        int span = rows[1] - rows[0];
        var lefts = new System.Collections.Generic.List<int>();
        var rights = new System.Collections.Generic.List<int>();
        for (int y = rows[0] + span / 5; y < rows[1] - span / 5; y += 3)
        {
            int l = EdgeInRow(pixels, width, y, bg, true), r = EdgeInRow(pixels, width, y, bg, false);
            if (l >= 0 && r > l) { lefts.Add(l); rights.Add(r); }
        }
        if (lefts.Count < 10) return null;
        lefts.Sort(); rights.Sort();
        int left = lefts[lefts.Count / 2], right = rights[rights.Count / 2];
        int cardW = right - left;
        var tops = new System.Collections.Generic.List<int>();
        var bottoms = new System.Collections.Generic.List<int>();
        for (int x = left + cardW / 5; x < right - cardW / 5; x += 3)
        {
            int t = EdgeInColumn(pixels, width, height, x, bg, true), b = EdgeInColumn(pixels, width, height, x, bg, false);
            if (t >= 0 && b > t) { tops.Add(t); bottoms.Add(b); }
        }
        if (tops.Count < 10) return null;
        tops.Sort(); bottoms.Sort();
        return new[] { left, tops[tops.Count / 2], right, bottoms[bottoms.Count / 2] };
    }

    static Bitmap RotateOn(Bitmap source, double degrees, Color fill)
    {
        var result = new Bitmap(source.Width, source.Height, PixelFormat.Format24bppRgb);
        result.SetResolution(source.HorizontalResolution, source.VerticalResolution);
        using (var graphics = Graphics.FromImage(result))
        {
            graphics.Clear(fill);
            graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            graphics.TranslateTransform(source.Width / 2f, source.Height / 2f);
            graphics.RotateTransform((float)degrees);
            graphics.TranslateTransform(-source.Width / 2f, -source.Height / 2f);
            graphics.DrawImage(source, new Rectangle(0, 0, source.Width, source.Height));
        }
        return result;
    }
}
