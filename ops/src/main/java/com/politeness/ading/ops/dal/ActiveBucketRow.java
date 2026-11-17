package com.politeness.ading.ops.dal;

import lombok.Getter;
import lombok.Setter;

/** One activity bucket. The bucket format is decided by SQL: yyyy-MM-dd by day, yyyy-MM-ddTHH:00:00 by hour. */
@Getter
@Setter
public class ActiveBucketRow {

    private String bucket;
    private int total;
    private int users;
    private int loggedIn;
    private int standalone;
}
