package com.politeness.ading.ops.service;

import java.io.IOException;
import java.io.OutputStream;

/** Reads attachments from OSS. A separate interface so neither the pages nor the tests need to know about OSS. */
public interface AttachmentStore {

    void copyTo(String objectKey, OutputStream out) throws IOException;
}
