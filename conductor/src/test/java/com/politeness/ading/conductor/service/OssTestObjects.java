package com.politeness.ading.conductor.service;

import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSClientBuilder;
import com.aliyun.oss.model.DeleteObjectsRequest;
import com.aliyun.oss.model.ListObjectsRequest;
import com.aliyun.oss.model.OSSObjectSummary;
import com.aliyun.oss.model.ObjectListing;
import java.util.List;

/**
 * Tests that really hit OSS must delete the objects they uploaded; test data must not be left in the bucket for manual cleanup.
 * Credentials use the same environment variables as the live upload tests.
 */
public final class OssTestObjects {

    /** Only allows deleting under the test-only directory, so a miscomputed prefix cannot delete real issue reports */
    private static final String TEST_ROOT = "bug_report/test/";

    private OssTestObjects() {
    }

    /** Deletes all objects under prefix and returns how many were deleted */
    public static int deletePrefix(String prefix) {
        String normalized = prefix.replaceAll("^/+", "");
        if (!normalized.startsWith(TEST_ROOT) || normalized.length() <= TEST_ROOT.length()) {
            throw new IllegalArgumentException("Can only clean up test objects under " + TEST_ROOT + ": " + prefix);
        }
        String bucket = System.getenv("ADING_OSS_BUCKET");
        OSS oss = new OSSClientBuilder().build(System.getenv("ADING_OSS_ENDPOINT"),
                System.getenv("OSS_ACCESS_KEY_ID"), System.getenv("OSS_ACCESS_KEY_SECRET"));
        try {
            int deleted = 0;
            String marker = null;
            do {
                ObjectListing listing = oss.listObjects(new ListObjectsRequest(bucket)
                        .withPrefix(normalized).withMarker(marker).withMaxKeys(1000));
                List<String> keys = listing.getObjectSummaries().stream().map(OSSObjectSummary::getKey).toList();
                if (!keys.isEmpty()) {
                    oss.deleteObjects(new DeleteObjectsRequest(bucket).withKeys(keys).withQuiet(true));
                    deleted += keys.size();
                }
                marker = listing.isTruncated() ? listing.getNextMarker() : null;
            } while (marker != null);
            return deleted;
        } finally {
            oss.shutdown();
        }
    }
}
